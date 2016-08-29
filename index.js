const fs = require('mz/fs')
const crypto = require('crypto')
const path = require('path')
const {Writable} = require('stream')
const debug = require('debug')('nos-mkfat')

// Just enough FAT. We're only targeting FAT16, file times and attributes are
// not important and can be left as zero
class FAT {
	constructor(params) {
		params = params || {}
		this.serial = params.serial || crypto.randomBytes(4)
		this.name = Buffer.alloc(11, ' ')
		this.name.write(params.name || 'nos-fat')
		this.entries = []
		this.root  = {name:'', parent:null, entries:[], type:'dir'}
		this.pwd   = this.root
		this.fatCount = params.fatCount || 1
		this.reservedSectors = params.reservedSectors || 1
		this.mediaDescriptor = params.mediaDescriptor || 0xF8
		this.extraSpace = params.extraSpace || 0
	}
	addSpace(bytes) {
		this.extraSpace += bytes
	}
	entry(name, type, size, {fd, target, entries, parent}) {
		let pos = this.entries.length
		let entry = {type, name, pos, fd, target, entries, parent, location:undefined}
		this.entries.push(entry)
		this.pwd.entries.push(entry)
		return entry
	}
	file(name, fd) {
		this.entry(name, 'file', undefined, {fd})
		return this
	}
	link(name, target) {
		this.entry(name, 'link', 0, {target})
		return this
	}
	dir(name) {
		let entry = this.entry(name, 'dir', undefined, {entries:[], parent:this.pwd})
		this.pwd = entry
		this.link('.', entry)
		this.link('..', entry.parent)
		return this
	}
	dotdot() {
		this.pwd = this.pwd.parent || this.root
		return this
	}
	getFile(target) {
		if (!(typeof target === 'string')) return target
		let segments = target.split('/')
		let dir = this.root
		if (segments[0] === '') {
			// omit the first entry (root), and last entry (filename)
			segments.slice(1, -1).forEach(segment=>{
				let dir_entry = dir.find(({name})=>name===segment)
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
			if (entry.type === 'dir')
				entry.size = entry.entries.length * 32
		})
	}
	assignClusterSize() {
		// files should have sizes before this is called
		this.dataSectors = sectorsNeeded(this.entries)
		let minimumClusters = this.entries.filter(e=>e.type!=='link').length
		this.clusterSize = calcClusterSize(this.dataSectors + Math.ceil(this.extraSpace/512), minimumClusters)
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
		let sectors = Math.ceil(dir.size / 512)
		let buffer = Buffer.alloc(sectors * 512)
		dir.entries.forEach((entry,i)=>{
			dirEntry(entry).copy(buffer, i*32)
		})
		return buffer
	}
	makeRootDir() {
		// files should have sizes and locations before this is called
		this.root.size = this.root.entries.length * 32
		let rootDir = this.makeDirBuffer(this.root)
		this.maxRootEntries = rootDir.length / 32
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
			lastCluster += Math.floor(entry.size / 512 / this.clusterSize)
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
		return this.maxRootEntries * 32 / 512
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

const fdSize = fd=>fs.fstat(fd).then(stat=>stat.size)

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
function dirEntry({name, location, size, type, attributes, target}) {
	attributes = attributes || {}
	if (type === 'link' && target.type === 'dir') type = 'dir'
	attributes.type = type

	if (name === name.toLowerCase()) {
		attributes.lowercase = true
	} else {
		debug(`Non-uppercase name ${name}`)
	}
	name = name.toUpperCase()

	if (type === 'dir') {
		size = 0
	}

	let nameBuf = writeName(name)
	let entry = Buffer.alloc(32)

	nameBuf.copy(entry)
	entry.writeUInt16LE(location, 26)
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

	if (attributes.lowercase) {
		entry.writeUInt8(16|8, 12) // bits 2³ and 2⁴ mark lowercase basename and extension respectively
	}

	debug('entry %s', name)
	debug(entry.toString('hex'), entry.length)

	/*
	time = time || new Date
	attribute = attribute || 0

	let fattime = time.getUTCHours() << 11
	fattime += time.getMinutes() << 5
	fattime += time.getSeconds() / 2

	let fatdate = (time.getUTCFullYear() - 1980) << 9
	fatdate += (time.getUTCMonth() + 1) << 5
	fatdate += time.getUTCDay() + 1

	entry.writeUInt8(attribute, 11)
	entry.writeUInt16LE(fattime, 22)
	entry.writeUInt16LE(fatdate, 24)
	*/

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

	let input = fs.createReadStream(null,{fd:inFD})
	let pos = 0
	let output = new Writable({
		write(chunk, encoding, callback) {
			fs.write(outFD, chunk, 0, chunk.length, location + pos, callback)
			pos = pos + chunk.length
		}
	})

	input.pipe(output).on('end', resolve).on('error', reject)

	return promise
}


module.exports = FAT
