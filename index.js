const fs = require('mz/fs')
const crypto = require('crypto')
const path = require('path')

function writeName(name, ext) {
	if (!ext) {
		ext = path.extname(name)
		name = path.basename(name, ext)
	}
	let ret = Buffer.alloc(11, ' ')
	ret.write(name)
	ret.write(ext, 8)
	return ret
}

const fdSize = fd=>fs.fstat(fd).then(stat=>stat.size)

// Just enough FAT. We're only targeting FAT16, file times and attributes are
// not important and can be left as zero
class FAT {
	constructor(name, serial) {
		this.serial = serial || crypto.randomBytes(4)
		this.name = Buffer.alloc(8, ' ')
		this.name.write(name || 'nos-fat')
		this.files = []
	}
	bootcode(buffer) {
		this._bootcode = buffer
	}
	file(name, fd) {
		this.files.push({name, fd})
		return this
	}
	filesWithSizes() {
		let sizes = this.files.map(fdSize)
		return Promise.all(sizes).then(sizes=>sizes.map( (size,i)=>this.files[i].size = size ))
	}
	dirEntry({name, location, size}) {
		let nameBuf = writeName(name)
		let entry = Buffer.alloc(32)

		nameBuf.copy(entry)
		entry.writeUInt16LE(location, 26)
		entry.writeUInt32LE(size, 28)

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
	sectorsNeeded() {
		// files should have sizes calculated before this is called
		let files = this.files
		return files.reduce((prev,{size})=>prev+size, 0)/512
	}
	calcClusterSize(sectors, fileCount) {
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
			throw new Error("Things have gotten out of hand, and won't fit on a FAT16 volume")
		}
	}
	assignLocations() {
		// files should have sizes before this is called
		let files = this.files
		this.dataSectors = this.sectorsNeeded(files)
		this.clusterSize = this.calcClusterSize(this.dataSectors, files.length)
		let csize = this.clusterSize * 512
		let cluster = 2;
		files.map(file=>{
			file.pos = cluster
			cluster += Math.ceil(file.size/csize)
			return file
		})
		this.dataClusters = cluster - 1
		return files
	}
	rootDir() {
		// files should have sizes and locations before this is called
		let files = this.files
		let rootDirSectors = Math.ceil(files.length * 32 / 512)
		this.maxRootEntries = rootDirSectors * 512 / 32

		let rootDir = Buffer.alloc(512 * rootDirSectors)
		files.forEach((file,i)=>{
			dirEntry(file).copy(rootDir, i*32)
		})

		return rootDir
	}
	makeFAT() {
		let buffer = Buffer.alloc(this.dataClusters * 16)
		buffer.writeUInt16LE(0xFFFF, 0)
		buffer.writeUInt16LE(0xFFF8, 16) // the end of file marker

		// The table should be mostly full. We'll pre-fill it in-order, and then
		// come back and mark the ends of files.
		for (let i = 2; i < this.dataClusters; i++) {
			let offset = 16*i
			let nextCluster = i+i
			buffer.writeUInt16LE(nextCluster, offset)
		}

		this.files.forEach(file=>{
			let lastCluster = file.location
			lastCluster += Math.floor(file.size / 512 / this.clusterSize)
			buffer.writeUInt16LE(0xFFF8, lastCluster)
		})

		return buffer
	}
	fatSectors() {
		return Math.ceil(this.dataClusters * 16 / 512)
	}
	rootDirSectors() {
		return this.maxRootEntries * 32 / 512
	}
	dataAreaSectors() {
		return this.dataClusters * this.clusterSize
	}
	countAllSectors() {
		let reservedSector = 1
		let fatsectors = this.fatSectors()
		let fatcount = 1
		let rootdirsectors = this.rootDirSectors()
		// Not suitable as there are cases where trailing zeros are necessary
		// let datasectors = this.dataSectors()
		let dataareasectors = this.dataClusters * this.clusterSize

		return reservedSector + (fatsectors * fatcount) + rootdirsectors + dataareasectors
	}
	makeBootSector() {
		let sectorSize = 512
		let fatCount = 1
		let reservedSectors = 1
		let buffer = Buffer.alloc(512, 0)

		let sectorCount = this.countAllSectors()
		let smallSectorCount = 0
		let largeSectorCount = 0
		if (sectorCount <= 0xFFFF) {
			smallSectorCount = sectorCount
		} else {
			largeSectorCount = sectorCount
		}
		
		let namebuf = Buffer.alloc(8, ' ')
		namebuf.write(this.name)
		namebuf.copy(buffer, 0x03)

		// Some of the below are simply copied from some other source and seem to
		// work. Most of these are labelled with whatever information was
		// provided.
		buffer.writeUInt16LE(sectorSize,          0x0B)
		buffer.writeUInt8   (this.clusterSize,    0x0D)
		buffer.writeUInt16LE(reservedSectors,     0x0E)
		buffer.writeUInt8   (fatCount,            0x10)
		buffer.writeUInt16LE(this.maxRootEntries, 0x11)
		buffer.writeUInt16LE(smallSectorCount,    0x13)
		buffer.writeUInt8   (0xF8,                0x15) // mark type as harddisk
		buffer.writeUInt16LE(this.fatSectors(),   0x16)
		buffer.writeUInt16LE(0x20,                0x18) // CHS - sectors
		buffer.writeUInt16LE(0x40,                0x1A) // CHS - heads
		buffer.writeUInt32LE(0x00,                0x1C) // hidden sectors
		buffer.writeUInt32LE(largeSectorCount,    0x20)
		buffer.writeUInt8   (0x80,                0x24) // logical drive number
		buffer.writeUInt8   (0x00,                0x25) // reserved
		buffer.writeUInt8   (0x29,                0x26) // magic number - Indicates following 3 fields are present
		this.serial.copy(buffer,                  0x27)
		namebuf.copy    (buffer,                  0x2B)
		Buffer.from('FAT16   ').copy(buffer,      0x36)

		if (this._bootcode) {
			this._bootcode.copy(buffer, 0, 0, 3)    // Copy first 3 bytes - a jump instruction
			this._bootcode.copy(buffer, 0x5A, 0x5A) // Copy bootcode
		}

		return buffer
	}
	makeDisk(outputFD) {
		fs.write
	}

}
