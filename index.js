const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const {Writable, PassThrough, Readable} = require('stream')
const debug = require('debug')('nos-mkfat')

class FAT {
	constructor(params) {
		params = params || {}
		this.serial = params.serial || crypto.randomBytes(4)
		this.name = Buffer.alloc(11, ' ')
		this.name.write(params.name || 'nos-fat')
		this.entries = []
		this.fatCount = params.fatCount || 1
		this.reservedSectors = params.reservedSectors || 1
		this.mediaDescriptor = params.mediaDescriptor || 0xF8
		this.extraSpace = params.extraSpace || 0
		this.defaultTime = params.defaultTime || undefined
	}
	reserveSpace(bytes) {
		this.extraSpace += bytes
	}
	entry(stat, data) {
		stat = Object.assign({
			name: '/',
			size: 0,
			type: 'file'
		}, stat)

		if (!stat.name.startsWith('/'))
			stat.name = '/' + stat.name

		if (stat.type === 'file' && !data)
			data = new PassThrough

		this.entries.push({stat, data})
		return data
	}
	getFile(target) {
		return this.entries.find(({stat:{name}})=>name===target)
	}
	dirEntries(dirPath) {
		let slicePos = dirPath.length

		function matchDir({stat}) {
			let path = stat.name
			if (path.slice(0, slicePos) !== dirPath) return false

			let relative = path.slice(slicePos)
			return (relative && relative.indexOf('/') === -1)
		}
		return this.entries.filter(matchDir)
	}
	directories() {
		return this.entries.filter(({stat:{type}})=>type==='directory')
	}
	calcDirSizes() {
		this.directories().forEach(({stat:dirstat})=>{
			// Yay! O(n²) on this.entries. (Not Yay)
			let entries = this.dirEntries(dirstat.name)
			let lfnEntryCount = entries.
				map(sub=>lfnCount(sub.name)).
				reduce((a,b)=>a+b, 0)
			debug(lfnEntryCount)
			dirstat.size =  (entries.length + lfnEntryCount) * 32
		})
	}
	assignClusterSize() {
		// files should have sizes before this is called
		this.dataSectors = sectorsNeeded(this.entries)
		let minimumClusters = this.entries.filter(e=>e.stat.type!=='link').length
		this.clusterSize = calcClusterSize(this.dataSectors + Math.ceil(this.extraSpace/512), minimumClusters)
		debug('Calculated a clusterSize of %s', this.clusterSize)
	}
	assignFileLocations() {
		// files should have sizes before this is called
		// clusterSize should be assigned
		let files = this.entries.filter(e=>e.type==='file')
		let csize = this.clusterSize * 512
		let cluster = 2
		this.entries.forEach(entry=>{
			let stat = entry.stat
			if (stat.type !== 'link') {
				stat.cluster = cluster
				cluster += Math.ceil(stat.size/csize)
			} else {
				// The linked file must be declared before the link, or this will fail
				let file = this.getFile(entry.data)
				stat.target = file.stat
				stat.cluster = file.stat.cluster
				// I'm assuming that by now nothing is going to be messeg up by a
				// link having a size
				stat.size = file.stat.size
			}
		})
		this.dataClusters = cluster - 1
		if (this.dataClusters < 4085)
			this.extraSpace = Math.max(this.extraSpace, (4085 - this.dataClusters) * csize)
		return files
	}
	makeDirBuffer(dir) {
		// files should have sizes and locations before this is called
		let buffers = []
		if (dir.stat.name !== '/') {
			let parentName = path.dirname(dir.stat.name)
			let self = Object.assign({name: '.'}, dir.stat)
			let parent

			if (parentName === '/') {
				parent = {name:'..'}
			} else {
				parent = Object.assign({name:'..'}, this.getFile(parentName).stat)
			}

			buffers.push(dirEntry(self))
			buffers.push(dirEntry(parent))
		}
		this.dirEntries(dir.stat.name).forEach((entry,i)=>{
			if (lfnCount(entry.stat.name) > 0) {
				buffers.push(makeLfnEntries(entry.stat.name))
			}
			buffers.push(dirEntry(entry.stat))
		})
		return Buffer.concat(buffers)
	}
	makeRootDir() {
		// files should have sizes and locations before this is called
		let rootEntries = this.dirEntries('/')
		let lfnEntryCount = rootEntries.
			map(sub=>lfnCount(sub.stat.name)).
			reduce((a,b)=>a+b, 0)
		rootEntries += lfnEntryCount
		let rootSectors = Math.ceil(rootEntries.length / 16)
		this.maxRootEntries = 16 * rootSectors
		return this.makeDirBuffer({stat:{name:'/'}})
	}
	makeFAT() {
		let buffer = Buffer.alloc(this.dataClusters * 16)
		buffer.writeUInt8(this.mediaDescriptor, 0)
		buffer.writeUInt8(0xFF, 1)
		buffer.writeUInt16LE(0xFFFF, 2) // the end of file marker

		debug(`making FAT. dataClusters:${this.dataClusters}`)
		// The table should be mostly full. We'll pre-fill it in-order, and then
		// come back and mark the ends of files. We're not expecting any empty
		// clusters, and we don't care about them anyway.
		for (let i = 2; i < this.dataClusters; i++) {
			let offset = 2*i // two bytes per entry
			let nextCluster = i+1
			buffer.writeUInt16LE(nextCluster, offset)
		}

		this.entries.forEach(entry=>{
			if (entry.stat.type === 'link') return
			let lastCluster = entry.stat.cluster
			lastCluster += Math.ceil(entry.stat.size / 512 / this.clusterSize) - 1
			buffer.writeUInt16LE(0xFFFF, lastCluster * 2) // two bytes per entry
			debug(`Terminated entry ${entry.stat.name} at cluster ${lastCluster}.`)
		})

		return buffer
	}
	emptyClusters() {
		return Math.ceil(this.extraSpace / 512 / this.clusterSize)
	}
	fatSectors() {
		return Math.ceil((this.dataClusters + this.emptyClusters())* 16 / 512)
	}
	rootDirSectors() {
		return Math.ceil(this.maxRootEntries * 32 / 512)
	}
	dataAreaSectors() {
		return this.dataClusters * this.clusterSize
	}
	countAllSectors() {
		let fatsectors = this.fatSectors()
		let rootdirsectors = this.rootDirSectors()
		// Not suitable as there are cases where trailing zeros are necessary
		// let datasectors = this.dataSectors()
		let dataareasectors = this.dataClusters * this.clusterSize
		let emptysectors = this.emptyClusters() * this.clusterSize
		debug(`Counting all Sectors. ${fatsectors}, ${rootdirsectors}, ${dataareasectors}, ${emptysectors}`)

		return this.reservedSectors + (fatsectors * this.fatCount) + rootdirsectors + dataareasectors + emptysectors
	}
	rootDirLocation() {
		return 512 * (this.reservedSectors + this.fatCount * this.fatSectors())
	}
	makeBootSector() {
		let buffer = Buffer.alloc(512, 0)

		let sectorCount = this.countAllSectors()
		let smallSectorCount = 0
		let largeSectorCount = 0
		if (sectorCount <= 0xFFFF) {
			smallSectorCount = sectorCount
		} else {
			largeSectorCount = sectorCount
		}
		
		let oemName = Buffer.from("nos-fat")
		oemName.copy(buffer, 0x03)

		// Some of the below are simply copied from some other source and seem to
		// work. Most of these are labelled with whatever information was
		// provided.
		buffer.writeUInt16LE(512,                  0x0B) // sector size
		buffer.writeUInt8   (this.clusterSize,     0x0D)
		buffer.writeUInt16LE(this.reservedSectors, 0x0E)
		buffer.writeUInt8   (this.fatCount,        0x10)
		buffer.writeUInt16LE(this.maxRootEntries,  0x11)
		buffer.writeUInt16LE(smallSectorCount,     0x13)
		buffer.writeUInt8   (this.mediaDescriptor, 0x15)
		buffer.writeUInt16LE(this.fatSectors(),    0x16)
		buffer.writeUInt16LE(0x20,                 0x18) // CHS - sectors
		buffer.writeUInt16LE(0x40,                 0x1A) // CHS - heads
		buffer.writeUInt32LE(0x00,                 0x1C) // hidden sectors
		buffer.writeUInt32LE(largeSectorCount,     0x20)
		buffer.writeUInt8   (0x80,                 0x24) // logical drive number
		buffer.writeUInt8   (0x00,                 0x25) // reserved
		buffer.writeUInt8   (0x29,                 0x26) // magic number - Indicates following 3 fields are present
		this.serial.copy(buffer,                   0x27)
		this.name.copy  (buffer,                   0x2B)
		Buffer.from('FAT16   ').copy(buffer,       0x36)

		buffer.writeUInt16BE(0x55AA,              0x1FE)

		return buffer
	}
	makeDisk(outputFD) {
		this.outputFD = outputFD

		this.calcDirSizes()
		this.assignClusterSize()
		this.assignFileLocations()
		debug('File locations assigned')

		let rootDir = this.makeRootDir()
		let bss = this.makeBootSector()
		let fat = this.makeFAT()
		let lastByte = this.countAllSectors() * 512 - 1

		debug('root directory')
		debug(rootDir.toString('hex'))

		debug('FAT')
		//debug(fat.toString('hex'))

		let datawritten = writeBuffer(Buffer.alloc(1), outputFD, lastByte).then(()=>{ // pre-allocate space, including final padding
			debug(`Pre allocated space by writing a 0 at ${lastByte}`)
			let dataAreaStart = this.rootDirLocation() + this.rootDirSectors() * 512

			debug(`Data Area starts at ${dataAreaStart} because rootDir starts at ${this.rootDirLocation()}, and has ${this.rootDirSectors()} sectors`)

			let filesWriteActions = this.entries.map(entry=>{
				if (entry.stat.type === 'link') return ()=>Promise.resolve()
				let entryStart = dataAreaStart + 512 * this.clusterSize * (entry.stat.cluster-2)
				debug(`Writing entry ${entry.stat.name} at offset ${entryStart}`)
				if (entry.stat.type === 'file')
					return ()=>writeFile(entry.data, outputFD, entryStart)
				if (entry.stat.type === 'directory')
					return ()=>writeBuffer(this.makeDirBuffer(entry), outputFD, entryStart)
			})
			debug(`Writing root directory at ${this.rootDirLocation()}`)
			let rootWriteAction = ()=>writeBuffer(rootDir, outputFD, this.rootDirLocation())
			let bssWriteAction = ()=>writeBuffer(bss, outputFD, 0)
			let fatSize = this.fatSectors()
			let fatWriteActions = []
			for (let i=0; i<this.fatCount; i++) {
				let p = ()=>writeBuffer(fat, outputFD, this.reservedSectors * 512 + i*fatSize)
				fatWriteActions.push(p)
			}

			let outputActions = filesWriteActions
			outputActions.push(rootWriteAction)
			outputActions.push(bssWriteAction)
			outputActions.push(...fatWriteActions)

			return sequence(outputActions)
		})

		return datawritten
	}
}

function writeName(name, ext) {
	name = name.replace(/ /g, '').toUpperCase()
	if (!ext) {
		ext = path.extname(name)
		name = path.basename(name, ext)
		ext = ext.slice(1)
	}
	let ret = Buffer.alloc(11, ' ')
	ret.write(name)
	ret.write(ext, 8)
	return ret
}

function fdSize(fd) {
	return new Promise((resolve,reject)=>{
		Promise.resolve(fd).then(stat).catch(debug)
		function stat(fd) {
			fs.fstat(fd, (err,stat)=>{
				if (err)
					reject(err)
				else
					resolve(stat.size)
			})
		}
	})
}

function dirEntry(stat) {
	let {name, cluster, size, type, target, mtime:time} = stat

	if (type === 'link') debug('link %s %s %s', name, type, target.stat.type)
	if (type === 'link' && target.stat.type === 'directory') type = 'directory'

	let ext = path.extname(name)
	let base = path.basename(name, ext)

	let lowercase_ext = false
	let mixed_ext = false
	let lowercase_base = false
	let mixed_base = false

	if (ext === ext.toLowerCase())
		lowercase_ext = true
	else if (ext !== ext.toUpperCase())
		mixed_ext = true

	if (base === base.toLowerCase())
		lowercase_base = true
	else if (base !== base.toUpperCase())
		mixed_base = true

	let nameBuf = writeName(name)
	let entry = Buffer.alloc(32)

	nameBuf.copy(entry)

	// I guess this is a little out of place for a FAT16 only utility. Although
	// FAT16 seems to consider 0x14 as access time, FAT32 seems to override that
	// for the high bits of the address. I may as well leave this here. Zeroeing
	// the field in FAT16 seems perfectly reasonable.
	let locationLow = cluster & 0xffff
	let locationHigh = cluster >> 16
	entry.writeUInt16LE(locationHigh, 0x14)
	entry.writeUInt16LE(locationLow, 26)
	entry.writeUInt32LE(size, 28)

	let attr = 0
	attr |= stat.ro     && 0x01
	attr |= stat.hidden && 0x02
	attr |= stat.system && 0x04
	attr |= stat.volume && 0x08 // yeah, not likely...
	attr |= stat.longfn && 0x0f // the long filename tag. we're not generating these
	attr |= (stat.type === 'directory') && 0x10
	attr |= stat.archive && 0x20
	entry.writeUInt8(attr, 11)

	let lowercaseAttr = (lowercase_ext && 16) | (lowercase_base && 8)
	entry.writeUInt8(lowercaseAttr, 12)

	debug('entry %s', name)
	debug(entry.toString('hex'), entry.length)

	time = time || this.defaultTime
	if (time instanceof Date) {
		let fattime = time.getUTCHours() << 11
		fattime += time.getUTCMinutes() << 5
		fattime += time.getUTCSeconds() / 2

		let fatdate = (time.getUTCFullYear() - 1980) << 9
		fatdate += (time.getUTCMonth() + 1) << 5
		fatdate += time.getUTCDay() + 1

		let ctime_hundredths = time.getUTCSeconds() % 2 + Math.floor(time.getUTCMilliseconds() / 10)

		entry.writeUInt8(ctime_hundredths, 0x0d)
		entry.writeUInt16LE(fattime, 0x0e) //c_time
		entry.writeUInt16LE(fatdate, 0x10) //c_date
		entry.writeUInt16LE(fatdate, 0x12) //a_date
		entry.writeUInt16LE(fattime, 22) //m_time
		entry.writeUInt16LE(fatdate, 24) //m_date
	}

	return entry
}
function sectorsNeeded(files) {
	// files should have sizes calculated before this is called
	return files.reduce((prev,{size})=>prev+(size||0), 0)/512
}
function calcClusterSize(sectors, fileCount) {
	// cluster sizes in sectors may be powers of two greater >=4 and <=64
	// 4, 8, 16, 32, 64
	if (sectors < 4 * (4085 + fileCount)) {
		return 4 // Empty space will need to be added to the end of the output to avoid triggering FAT12 interpretation
	} else if (sectors < 8 *  (4085 + fileCount)) {
		return 4 // Padding unnecessary.
	} else if (sectors < 16 * (4085 + fileCount)) {
		return 8
	} else if (sectors < 32 * (4085 + fileCount)) {
		return 16
	} else if (sectors < 64 * (4085 + fileCount)) {
		return 32
	} else if (sectors < 64 * (65525 + fileCount)) {
		return 64
	} else {
		throw new Error(`Things have gotten out of hand, and won't fit on a FAT16 volume. Sectors:${sectors}, Files:${fileCount}`)
	}
}
function writeBuffer(buffer, fd, location) {
	let resolve, reject
	let promise = new Promise((res,rej)=>{resolve=res; reject=rej})
	fs.write(fd, buffer, 0, buffer.length, location, (err, written)=>{
		if (err || written !== buffer.length) {
			reject(err || buffer.length - written)
		} else {
			resolve()
		}
	})
	return promise
}
function writeFile(input, outFD, location) {
	let resolve, reject
	let promise = new Promise((res,rej)=>{resolve=res; reject=rej})

	if (input instanceof Buffer) {
		return writeBuffer(input, outFD, location)
	} else if (input instanceof Readable) {
		let pos = 0
		let output = new Writable({
			write(chunk, encoding, callback) {
				fs.write(outFD, chunk, 0, chunk.length, location + pos, callback)
				pos = pos + chunk.length
			}
		})

		input.pipe(output).on('finish', resolve).on('error', reject)
	} else {
		let buffer = Buffer.from(input)
		return writeBuffer(input, outFD, location)
	}

	return promise
}
function lfnCount(name) {
	let ext = path.extname(name)
	let basename = path.basename(name, ext)

	// ext will have an initial '.'
	if (basename.length > 8 || ext.length > 4)
		return Math.ceil(name.length / 13)
	else
		return 0
}
function makeLfnEntry(nameBuffer, pos, csum) {
	let entry = Buffer.alloc(32)
	entry[0x00] = pos
	entry[0x0b] = 0x0f
	entry[0x0d] = csum
	// bytes 0x0c, 0x1a & 0x1b should remain as 0x00.
	nameBuffer.copy(entry, 0x01, 0x00, 0x0a)
	nameBuffer.copy(entry, 0x0e, 0x0a, 0x16)
	nameBuffer.copy(entry, 0x1c, 0x16, 0x1a)
	debug("mle:", nameBuffer, entry)
	return entry
}
function makeLfnEntries(name) {
	let lfnC = lfnCount(name)
	let ret = Buffer.alloc(lfnC * 32)
	let ucs2 = Buffer.from(name, 'ucs2')
	let dosname = writeName(name)
	let csum = dosname[0]
	for (let i=1; i<11; i++) {
		let rotated = (csum << 7) | (csum >>> 1) & 0xFF
		csum = (rotated + dosname[i]) & 0xFF
	}

	for (let i=0; i<lfnC; i++) {
		let order = i?(lfnC - i):(lfnC + 0x40)
		let nameBuf = Buffer.alloc(26, 0xff)
		let start = (lfnC - i - 1) * 26
		ucs2.copy(nameBuf, 0, start, start + 26)
		if (i === 0) {
			let shortfall = lfnC * 26 - ucs2.length
			nameBuf[27 - shortfall] = 0x00
			nameBuf[26 - shortfall] = 0x00
		}
		let entry = makeLfnEntry(nameBuf, order, csum)
		entry.copy(ret, i*32)
	}
	return ret
}

function sequence(actions) {
	return new Promise((resolve, reject)=>{
		consumeAction()
		function consumeAction() {
			debug(`CONSUME [${actions.length}]`)
			if (actions.length === 0) return resolve()
			let action = actions.shift()
			debug("ACTION", action)
			let p = action()
			p.then(consumeAction, error)
		}
		function error(e) {
			debug(e)
			reject(e)
		}
	})
}


module.exports = FAT
