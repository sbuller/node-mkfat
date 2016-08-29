# nos-mkfat
Build a simple FAT16 filesystem image

The approach I'm taking makes several assumptions to keep it simple:

2.  filesystem size will not exceed 512 * 64 * 65525 [sic] bytes + fs data.
3.  no long filenames
6.  all files to be added will come from existing file descriptors
8.  the files to be added are all declared before the filesystem is generated
9.  the files sizes can be looked up before copying them to the filesystem
10.  ... more?

Some of these aren't hard to fix, but I'm not planning on working on them unless I find a need.

My main references have been:
https://www.win.tue.nl/~aeb/linux/fs/fat/fat-1.html
https://en.wikipedia.org/wiki/Design_of_the_FAT_file_system
http://www.c-jump.com/CIS24/Slides/FAT/lecture.html#F01_0140_root_directory
http://www.beginningtoseethelight.org/fat16/index.htm
