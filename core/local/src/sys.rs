//! The few system calls the local folder needs, each wrapped once.

use std::ffi::{CStr, CString};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use pneuma_base_storage::{FsFacet, Kind, Time, Token};

pub type Errno = i32;

fn last_errno() -> Errno {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// Names reach here from validated places or from readdir, neither of which holds a NUL.
pub fn c_name(name: &[u8]) -> CString {
    CString::new(name).unwrap_or_default()
}

pub fn open_root(path: &Path) -> Result<OwnedFd, Errno> {
    let path = c_name(path.as_os_str().as_bytes());
    // SAFETY: a valid C string; the returned descriptor is owned below.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    owned(fd)
}

/// Opens a directory below `dir` without following a symbolic link at its last component.
pub fn open_dir_at(dir: RawFd, name: &CStr) -> Result<OwnedFd, Errno> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `dir` is an open descriptor and `name` a valid C string.
    let fd = unsafe { libc::openat(dir, name.as_ptr(), flags) };
    owned(fd)
}

fn owned(fd: RawFd) -> Result<OwnedFd, Errno> {
    if fd < 0 {
        Err(last_errno())
    } else {
        // SAFETY: `fd` was just returned by the kernel and nothing else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

/// The metadata the local folder reads of one place, from one `lstat`-like call.
#[derive(Clone, Copy, Debug)]
pub struct Stat {
    pub kind: Kind,
    pub size: u64,
    pub mtime_ns: i128,
    pub ctime_ns: i128,
    pub btime_ns: Option<i128>,
    pub inode: u64,
    pub device: u64,
    pub mode: u32,
}

impl Stat {
    pub fn token(&self) -> Token {
        Token::new(format!(
            "v1;s={};m={};c={};i={}",
            self.size, self.mtime_ns, self.ctime_ns, self.inode
        ))
    }

    pub fn fs_facet(&self) -> FsFacet {
        FsFacet {
            inode: self.inode,
            device: self.device,
            created: self.btime_ns.map(Time::from_nanos),
            mode: self.mode,
        }
    }

    pub fn modified(&self) -> Time {
        Time::from_nanos(self.mtime_ns)
    }
}

fn ns(secs: i64, nanos: i64) -> i128 {
    i128::from(secs) * 1_000_000_000 + i128::from(nanos)
}

#[allow(clippy::unnecessary_cast)] // field widths differ between platforms
fn convert(st: &libc::stat) -> Stat {
    let mode = st.st_mode as u32;
    let kind = match mode & libc::S_IFMT as u32 {
        m if m == libc::S_IFREG as u32 => Kind::File,
        m if m == libc::S_IFDIR as u32 => Kind::Dir,
        _ => Kind::Other,
    };
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    let btime_ns = Some(ns(st.st_birthtime as i64, st.st_birthtime_nsec as i64));
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
    let btime_ns = None;
    // dev_t is a signed 32-bit number on macOS; its bits are the identity.
    #[cfg(target_os = "macos")]
    let device = st.st_dev as u32 as u64;
    #[cfg(not(target_os = "macos"))]
    let device = st.st_dev as u64;
    Stat {
        kind,
        size: st.st_size.max(0) as u64,
        mtime_ns: ns(st.st_mtime as i64, st.st_mtime_nsec as i64),
        ctime_ns: ns(st.st_ctime as i64, st.st_ctime_nsec as i64),
        btime_ns,
        inode: st.st_ino as u64,
        device,
        mode,
    }
}

/// `lstat` of `name` inside `dir`.
pub fn stat_at(dir: RawFd, name: &CStr) -> Result<Stat, Errno> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: valid descriptor, C string and out pointer.
    let rc = unsafe {
        libc::fstatat(
            dir,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc != 0 {
        return Err(last_errno());
    }
    // SAFETY: fstatat succeeded and filled the struct.
    Ok(convert(unsafe { st.assume_init_ref() }))
}

pub fn stat_fd(fd: RawFd) -> Result<Stat, Errno> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: valid descriptor and out pointer.
    if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
        return Err(last_errno());
    }
    // SAFETY: fstat succeeded and filled the struct.
    Ok(convert(unsafe { st.assume_init_ref() }))
}

pub fn stat_path(path: &Path) -> Result<Stat, Errno> {
    let path = c_name(path.as_os_str().as_bytes());
    stat_at(libc::AT_FDCWD, &path)
}

/// The number of entries of a directory, when the platform keeps it without listing.
#[cfg(target_os = "macos")]
pub fn entry_count_at(dir: RawFd, name: Option<&CStr>) -> Option<u64> {
    #[repr(C)]
    struct Buf {
        length: u32,
        count: u32,
    }
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: 0,
        dirattr: libc::ATTR_DIR_ENTRYCOUNT,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buf = Buf {
        length: 0,
        count: 0,
    };
    let list_ptr = (&raw mut list).cast();
    let buf_ptr = (&raw mut buf).cast();
    let size = std::mem::size_of::<Buf>();
    // SAFETY: the attribute list and buffer are valid for the sizes given.
    let rc = unsafe {
        match name {
            Some(name) => libc::getattrlistat(
                dir,
                name.as_ptr(),
                list_ptr,
                buf_ptr,
                size,
                libc::FSOPT_NOFOLLOW as libc::c_ulong,
            ),
            None => libc::fgetattrlist(dir, list_ptr, buf_ptr, size, 0),
        }
    };
    (rc == 0 && buf.length as usize >= size).then_some(u64::from(buf.count))
}

#[cfg(not(target_os = "macos"))]
pub fn entry_count_at(_dir: RawFd, _name: Option<&CStr>) -> Option<u64> {
    None
}

/// What readdir says an entry is, without a stat.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryType {
    File,
    Dir,
    Other,
    Unknown,
}

/// A directory stream over its own duplicate of a descriptor.
pub struct DirStream(*mut libc::DIR);

impl DirStream {
    pub fn open(dir: &impl AsRawFd) -> Result<DirStream, Errno> {
        // SAFETY: duplicating an open descriptor.
        let dup = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if dup < 0 {
            return Err(last_errno());
        }
        // SAFETY: `dup` is ours; on success the stream owns it.
        let stream = unsafe { libc::fdopendir(dup) };
        if stream.is_null() {
            let errno = last_errno();
            // SAFETY: fdopendir failed, so `dup` is still ours to close.
            unsafe { libc::close(dup) };
            return Err(errno);
        }
        // The duplicate shares the offset of `dir`, which an earlier listing may have moved.
        // SAFETY: a valid stream.
        unsafe { libc::rewinddir(stream) };
        Ok(DirStream(stream))
    }

    /// The next entry other than `.` and `..`; `None` at the end. The name borrows the stream.
    pub fn next_entry(&mut self) -> Option<Result<(&[u8], EntryType), Errno>> {
        loop {
            clear_errno();
            // SAFETY: a valid stream; the entry stays valid until the next call.
            let entry = unsafe { libc::readdir(self.0) };
            if entry.is_null() {
                let errno = last_errno();
                return (errno != 0).then_some(Err(errno));
            }
            // SAFETY: readdir returned a valid entry with a NUL-terminated name.
            let (name, d_type) = unsafe {
                let entry = &*entry;
                (
                    CStr::from_ptr(entry.d_name.as_ptr()).to_bytes(),
                    entry.d_type,
                )
            };
            if name == b"." || name == b".." {
                continue;
            }
            let kind = match d_type {
                libc::DT_REG => EntryType::File,
                libc::DT_DIR => EntryType::Dir,
                libc::DT_UNKNOWN => EntryType::Unknown,
                _ => EntryType::Other,
            };
            return Some(Ok((name, kind)));
        }
    }
}

impl Drop for DirStream {
    fn drop(&mut self) {
        // SAFETY: the stream is open and owned by us.
        unsafe { libc::closedir(self.0) };
    }
}

fn clear_errno() {
    // SAFETY: writing the calling thread's errno.
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    unsafe {
        *libc::__error() = 0;
    }
    // SAFETY: writing the calling thread's errno.
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location() = 0;
    }
}

/// The system's reason, as its symbolic name: data, not a sentence.
pub fn errno_name(errno: Errno) -> String {
    let name = match errno {
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EIO => "EIO",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EMFILE => "EMFILE",
        libc::ENFILE => "ENFILE",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOENT => "ENOENT",
        libc::EBUSY => "EBUSY",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ENXIO => "ENXIO",
        libc::EINTR => "EINTR",
        libc::EAGAIN => "EAGAIN",
        libc::EROFS => "EROFS",
        libc::ENOSPC => "ENOSPC",
        libc::EDQUOT => "EDQUOT",
        libc::ESTALE => "ESTALE",
        libc::ENOMEM => "ENOMEM",
        libc::EEXIST => "EEXIST",
        libc::EISDIR => "EISDIR",
        libc::EINVAL => "EINVAL",
        libc::EDEADLK => "EDEADLK",
        _ => return format!("errno {errno}"),
    };
    name.to_owned()
}

pub fn io_errno(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(errno) => errno_name(errno),
        None => format!("{:?}", error.kind()),
    }
}
