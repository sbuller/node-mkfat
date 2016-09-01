const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const {Writable} = require('stream')
const debug = require('debug')('nos-mkfat')

class Dir {
	constructor(entry, newEntry) {
		this._entry = entry
		this._newEntry = newEntry
	}
	dir(name) {
		let entry = this._newEntry(name, 'dir', this._entry, {entries:[]})
		return new Dir(entry, this._newEntry)
	}
	file(name, fd) {
		this._newEntry(name, 'file', this._entry, {fd})
		return this
	}
	link(name, target) {
		this._newEntry(name, 'link', this._entry, {target})
		return this
	}
}

class FAT {
	constructor(params) {
		params = params || {}
		this.serial = params.serial || crypto.randomBytes(4)
		this.name = Buffer.alloc(11, ' ')
		this.name.write(params.name || 'nos-fat')
		this.entries = []
		this._root  = {name:'', parent:null, entries:[], type:'dir'}
		this.fatCount = params.fatCount || 1
		this.reservedSectors = params.reservedSectors || 1
		this.mediaDescriptor = params.mediaDescriptor || 0xF8
		this.extraSpace = params.extraSpace || 0
		this.defaultTime = params.defaultTime || undefined
	}
	root() {
		return new Dir(this._root, (...args)=>this.entry(...args))
	}
	addSpace(bytes) {
		this.extraSpace += bytes
	}
	entry(name, type, parent, {fd, target, entries}) {
		let pos = this.entries.length
		let entry = {type, name, pos, fd, target, entries, parent, location:undefined}
		this.entries.push(entry)
		parent.entries.push(entry)
		if (type === 'dir') {
			this.entry('.', 'link', entry, {target:entry})
			this.entry('..', 'link', entry, {target:entry.parent})
		}
		return entry
	}
	getFile(target) {
		if (!(typeof target === 'string')) return target
		let segments = target.split('/')
		let dir = this._root
		if (segments[0] === '') {
			// omit the first entry (root), and last entry (filename)
			segments.slice(1, -1).forEach(segment=>{
				let dir_entry = dir.entries.find(({name})=>name===segment)
				if (!dir_entry) {
					throw new Error(`Target not found at '${segment}', in '${target}'.`)
				} else {
					dir = this.entries[dir_entry.pos]
				}
			})
		}
		// I'm intentionally ignoring more complicated relative paths
		// This handles immediate filenames and absolute paths
		let filename = segments.pop()
		let file = dir.entries.find(({name})=>name===filename)
		return file
	}
	calcDirSizes() {
		this.entries.forEach(entry=>{
			if (entry.type === 'dir') {
				let lfnEntryCount = entry.entries.
					map(sub=>lfnCount(sub.name)).
					reduce((a,b)=>a+b, 0)
				debug(lfnEntryCount)
				entry.size = (entry.entries.length + lfnEntryCount) * 32
			}
		})
	}
	assignClusterSize() {
		// files should have sizes before this is called
		this.dataSectors = sectorsNeeded(this.entries)
		let minimumClusters = this.entries.filter(e=>e.type!=='link').length
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
			if (entry.type !== 'link') {
				entry.location = cluster
				cluster += Math.ceil(entry.size/csize)
			} else {
				// The linked file must be declared before the link, or this will fail
				let file = this.getFile(entry.target)
				entry.target = file
				entry.location = file.location
				// I'm assuming that by now nothing is going to be messeg up by a
				// link having a size
				entry.size = file.size
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
		dir.entries.forEach((entry,i)=>{
			if (lfnCount(entry.name) > 0) {
				buffers.push(makeLfnEntries(entry.name))
			}
			buffers.push(dirEntry(entry))
		})
		return Buffer.concat(buffers)
	}
	makeRootDir() {
		// files should have sizes and locations before this is called
		let rootEntries = this._root.entries.length
		let lfnEntryCount = this._root.entries.
			map(sub=>lfnCount(sub.name)).
			reduce((a,b)=>a+b, 0)
		rootEntries += lfnEntryCount
		let rootSectors = Math.ceil(rootEntries / 16)
		this.maxRootEntries = 16 * rootSectors
		this._root.size = rootSectors * 512
		let rootDir = this.makeDirBuffer(this._root)
		return rootDir
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
			if (entry.type === 'link') return
			let lastCluster = entry.location
			lastCluster += Math.ceil(entry.size / 512 / this.clusterSize) - 1
			buffer.writeUInt16LE(0xFFFF, lastCluster * 2) // two bytes per entry
			debug(`Terminated entry ${entry.name} at cluster ${lastCluster}.`)
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

		let filesready = filesWithSizes(this.entries.filter(e=>e.type==='file'))
		this.calcDirSizes()

		let datawritten = filesready.then(files=>{
			debug('File sizes found')
			this.assignClusterSize()
			this.assignFileLocations()
			debug('File locations assigned')
			debug(files)

			let rootDir = this.makeRootDir()
			let bss = this.makeBootSector()
			let fat = this.makeFAT()
			let lastByte = this.countAllSectors() * 512 - 1
			debug('root directory')
			debug(rootDir.toString('hex'))
			debug('FAT')
			//debug(fat.toString('hex'))

			return writeBuffer(Buffer.alloc(1), outputFD, lastByte).then(()=>{ // pre-allocate space, including final padding
				debug(`Pre allocated space by writing a 0 at ${lastByte}`)
				let dataAreaStart = this.rootDirLocation() + this.rootDirSectors() * 512
				debug(`Data Area starts at ${dataAreaStart} because rootDir starts at ${this.rootDirLocation()}, and has ${this.rootDirSectors()} sectors`)
				let filesWritePromises = this.entries.map(entry=>{
					if (entry.type === 'link') return Promise.resolve()
					let entryStart = dataAreaStart + 512 * this.clusterSize * (entry.location-2)
					debug(`Writing entry ${entry.name} at offset ${entryStart}`)
					if (entry.type === 'file')
						return writeFile(entry.fd, outputFD, entryStart)
					if (entry.type === 'dir')
						return writeBuffer(this.makeDirBuffer(entry), outputFD, entryStart)
				})
				debug(`Writing root directory at ${this.rootDirLocation()}`)
				let rootWritePromise = writeBuffer(rootDir, outputFD, this.rootDirLocation())
				let bssWritePromise = writeBuffer(bss, outputFD, 0)
				let fatSize = this.fatSectors()
				let fatWritePromises = []
				for (let i=0; i<this.fatCount; i++) {
					let p = writeBuffer(fat, outputFD, this.reservedSectors * 512 + i*fatSize)
					fatWritePromises.push(p)
				}

				let outputPromises = filesWritePromises
				outputPromises.push(rootWritePromise)
				outputPromises.push(bssWritePromise)
				outputPromises.push(...fatWritePromises)

				return Promise.all(outputPromises)
			})
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

function filesWithSizes(files) {
	let sizes = files.map(file=>fdSize(file.fd))
	return (
		Promise.all(sizes)
		.then(sizes=>sizes.map( (size,i)=>{
			files[i].size = size
			return files[i]
		}))
	)
}
function dirEntry({name, location, size, type, attributes, target, time}) {
	attributes = attributes || {}
	if (type === 'link') debug('link %s %s %s', name, type, target.type)
	if (type === 'link' && target.type === 'dir') type = 'dir'
	attributes.type = type

	let ext = path.extname(name)
	let base = path.basename(name, ext)

	if (ext === ext.toLowerCase())
		attributes.lowercase_ext = true
	else if (ext !== ext.toUpperCase())
		attributes.mixed_ext = true

	if (base === base.toLowerCase())
		attributes.lowercase_base = true
	else if (base !== base.toUpperCase())
		attributes.mixed_base = true

	let nameBuf = writeName(name)
	let entry = Buffer.alloc(32)

	nameBuf.copy(entry)

	// I guess this is a little out of place for a FAT16 only utility. Although
	// FAT16 seems to consider 0x14 as access time, FAT32 seems to override that
	// for the high bits of the address. I may as well leave this here. Zeroeing
	// the field in FAT16 seems perfectly reasonable.
	let locationLow = location & 0xffff
	let locationHigh = location >> 16
	entry.writeUInt16LE(locationHigh, 0x14)
	entry.writeUInt16LE(locationLow, 26)
	entry.writeUInt32LE(size, 28)

	let attr = 0
	attr |= attributes.ro     && 0x01
	attr |= attributes.hidden && 0x02
	attr |= attributes.system && 0x04
	attr |= attributes.volume && 0x08 // yeah, not likely...
	attr |= attributes.longfn && 0x0f // the long filename tag. we're not generating these
	attr |= (attributes.type === 'dir') && 0x10
	attr |= attributes.archive && 0x20
	entry.writeUInt8(attr, 11)

	let lowercaseAttr = (attributes.lowercase_ext && 16) | (attributes.lowercase_base && 8)
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
function writeFile(inFD, outFD, location) {
	// this.outputFD should be set before writeFile is called
	let resolve, reject
	let promise = new Promise((res,rej)=>{resolve=res; reject=rej})

	if (inFD instanceof Promise) {
		inFD.then(write).catch(debug)
	} else {
		write(inFD)
	}

	function write(fd) {
		let input = fs.createReadStream(null,{fd})
		let pos = 0
		let output = new Writable({
			write(chunk, encoding, callback) {
				fs.write(outFD, chunk, 0, chunk.length, location + pos, callback)
				pos = pos + chunk.length
			}
		})

		input.pipe(output).on('end', resolve).on('error', reject)
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


module.exports = FAT
