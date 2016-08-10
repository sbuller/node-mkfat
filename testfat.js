let FAT = require('./index')
let fs = require('fs')
let foo = fs.openSync('./testfat.js', 'r')
let bar = fs.openSync('./index.js', 'r')
let baz = fs.openSync('./README.md', 'r')
let bss = fs.readFileSync('./ldlinux.bss')

let out = fs.openSync('./test.img', 'w')

let fat = new FAT

fat.file('foo', foo).file('bar', bar).file('baz', baz).bootcode(bss)
fat.makeDisk(out).catch(e=>console.log(e))
