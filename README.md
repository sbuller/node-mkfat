# nos-mkfat
Build a simple FAT16 filesystem image

The approach I'm taking makes several assumptions to keep it simple:

1.  no subdirectories
2.  filesystem size will not exceed 512 * 64 * 65525 [sic] bytes + fs data.
3.  no long filenames
4.  no special attributes
5.  no dates and times
6.  all files to be added will come from existing file descriptors
7.  the filesystem is made only big enough for the data it's designed to hold
8.  the files to be added are all declared before the filesystem is generated
9.  the files sizes can be looked up before copying them to the filesystem
10.  ... more?

Some of these aren't hard to fix, but I'm not planning on working on them unless I find a need.
