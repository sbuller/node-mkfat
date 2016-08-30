let FAT = require('./index')
let fs = require('fs')
let c32 = fs.openSync('./ldlinux.c32', 'r')
let sys = fs.openSync('./ldlinux.sys', 'r')
let baz = fs.openSync('./README.md', 'r')
let bss = fs.readFileSync('./ldlinux.bss')

let out = fs.openSync('./test.img', 'w')

let fat = new FAT

let root = fat.root()
let foo = root.dir('foo')
let xyzzy = root.dir('xyzzy')
root.file('ldlinux.c32', c32).file('ldlinux.sys', sys).file('baz', baz)

foo.link('bar', '/baz')
xyzzy.link('BAR.bar', '/foo/bar')
xyzzy.link('a really long file name.test', '/foo/bar')


fat.makeDisk(out).catch(e=>console.log(e))
