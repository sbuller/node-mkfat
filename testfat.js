let FAT = require('./index')
let fs = require('fs')
let c32 = './ldlinux.c32'
let sys = './ldlinux.sys'
let baz = './README.md'

let out = fs.openSync('./test.img', 'w')

let c32stat = fs.statSync(c32)
let sysstat = fs.statSync(sys)
let bazstat = fs.statSync(baz)

let c32stream = fs.createReadStream(c32)
let sysstream = fs.createReadStream(sys)
let bazstream = fs.createReadStream(baz)

let fat = new FAT

fat.entry({name:'foo', type:'directory'})
fat.entry({name:'xyzzy', type:'directory'})
c32stream.pipe(fat.entry({name:'ldlinux.c32', size:c32stat.size}))
sysstream.pipe(fat.entry({name:'ldlinux.sys', size:sysstat.size}))
bazstream.pipe(fat.entry({name:'baz', size:bazstat.size}))

fat.entry({name:'foo/bar', type:'link'}, '/baz')
fat.entry({name:'xyzzy/BAR.bar', type:'link'}, '/foo/bar')
fat.entry({name:'xyzzy/a really long file name.test', type:'link'}, '/foo/bar')

fat.entry({name:'boot', type:'directory'})
fat.entry({name:'syslinux', type:'directory'})

fat.makeDisk(out).catch(e=>console.log(e))
