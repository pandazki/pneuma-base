//! The few system calls the local folder needs, each wrapped once.

use std::ffi::{CStr, CString};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

use pneuma_base_storage::{Kind, Time, Token};

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
    /// The BSD file flags (`st_flags`); 0 where the platform has none.
    pub flags: u32,
}

/// Set on a file or directory whose content a sync provider keeps elsewhere (macOS `SF_DATALESS`).
pub const DATALESS: u32 = 0x4000_0000;

impl Stat {
    /// The components the file system gives a token: what a change to the place moves.
    pub fn components(&self) -> [(&'static str, String); 4] {
        [
            ("s", self.size.to_string()),
            ("m", self.mtime_ns.to_string()),
            ("c", self.ctime_ns.to_string()),
            ("i", self.inode.to_string()),
        ]
    }

    /// Only the components: the key a cached listing is filed under.
    pub fn token(&self) -> Token {
        Token::build(self.components(), [])
    }

    pub fn modified(&self) -> Time {
        Time::from_nanos(self.mtime_ns)
    }

    pub fn created(&self) -> Option<Time> {
        self.btime_ns.map(Time::from_nanos)
    }

    pub fn dataless(&self) -> bool {
        self.flags & DATALESS != 0
    }

    /// The latest moment the place's state changed, as its own clock says.
    pub fn last_change_ns(&self) -> i128 {
        self.mtime_ns.max(self.ctime_ns)
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
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
    let flags = st.st_flags as u32;
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
    let flags = 0;
    Stat {
        kind,
        size: st.st_size.max(0) as u64,
        mtime_ns: ns(st.st_mtime as i64, st.st_mtime_nsec as i64),
        ctime_ns: ns(st.st_ctime as i64, st.st_ctime_nsec as i64),
        btime_ns,
        inode: st.st_ino as u64,
        device,
        mode,
        flags,
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
        libc::EXDEV => "EXDEV",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::ENOSYS => "ENOSYS",
        libc::EFBIG => "EFBIG",
        _ => return format!("errno-{errno}"),
    };
    name.to_owned()
}

pub fn io_errno(error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(errno) => errno_name(errno),
        None => format!("{:?}", error.kind()),
    }
}

fn check(rc: libc::c_int) -> Result<(), Errno> {
    if rc == 0 { Ok(()) } else { Err(last_errno()) }
}

/// Opens a file below `dir` for reading, without following a symbolic link at its last component.
pub fn open_file_at(dir: RawFd, name: &CStr) -> Result<std::fs::File, Errno> {
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `dir` is an open descriptor and `name` a valid C string.
    let fd = unsafe { libc::openat(dir, name.as_ptr(), flags) };
    owned(fd).map(std::fs::File::from)
}

/// Makes a file below `dir` that must not exist yet, for writing.
pub fn create_file_at(dir: RawFd, name: &CStr, mode: u32) -> Result<std::fs::File, Errno> {
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `dir` is an open descriptor and `name` a valid C string.
    let fd = unsafe { libc::openat(dir, name.as_ptr(), flags, mode as libc::c_uint) };
    owned(fd).map(std::fs::File::from)
}

pub fn mkdir_at(dir: RawFd, name: &CStr, mode: u32) -> Result<(), Errno> {
    // SAFETY: `dir` is an open descriptor and `name` a valid C string.
    check(unsafe { libc::mkdirat(dir, name.as_ptr(), mode as libc::mode_t) })
}

pub fn unlink_at(dir: RawFd, name: &CStr, is_dir: bool) -> Result<(), Errno> {
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: `dir` is an open descriptor and `name` a valid C string.
    check(unsafe { libc::unlinkat(dir, name.as_ptr(), flags) })
}

/// How `rename_at` places the thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placing {
    /// Only where nothing is: fails with `EEXIST` otherwise.
    Exclusive,
    /// Swaps the two, both of which must exist.
    Swap,
    /// Replaces the file that is there in one step (`rename(2)`).
    Over,
}

pub fn rename_at(
    from_dir: RawFd,
    from: &CStr,
    to_dir: RawFd,
    to: &CStr,
    placing: Placing,
) -> Result<(), Errno> {
    #[cfg(target_os = "macos")]
    let flags = match placing {
        Placing::Exclusive => libc::RENAME_EXCL,
        Placing::Swap => libc::RENAME_SWAP,
        Placing::Over => 0,
    };
    #[cfg(target_os = "macos")]
    // SAFETY: open descriptors and valid C strings.
    let rc = unsafe { libc::renameatx_np(from_dir, from.as_ptr(), to_dir, to.as_ptr(), flags) };
    #[cfg(target_os = "linux")]
    let flags = match placing {
        Placing::Exclusive => libc::RENAME_NOREPLACE,
        Placing::Swap => libc::RENAME_EXCHANGE,
        Placing::Over => 0,
    };
    #[cfg(target_os = "linux")]
    // SAFETY: open descriptors and valid C strings.
    let rc = unsafe { libc::renameat2(from_dir, from.as_ptr(), to_dir, to.as_ptr(), flags) };
    check(rc)
}

/// Holds an exclusive advisory lock on an open descriptor until it is closed.
pub fn lock(fd: RawFd) -> Result<(), Errno> {
    loop {
        // SAFETY: a valid descriptor.
        match check(unsafe { libc::flock(fd, libc::LOCK_EX) }) {
            Err(libc::EINTR) => continue,
            other => return other,
        }
    }
}

/// When the entry `name` was added to `dir` (macOS keeps it per directory entry), or `None` where
/// the file system does not keep it.
#[cfg(target_os = "macos")]
pub fn added_at(dir: RawFd, name: &CStr) -> Option<i128> {
    #[repr(C, packed(4))]
    struct Buf {
        length: u32,
        returned: libc::attribute_set_t,
        time: libc::timespec,
    }
    let mut list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_ADDEDTIME,
        volattr: 0,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buf = std::mem::MaybeUninit::<Buf>::zeroed();
    let options = libc::FSOPT_NOFOLLOW | libc::FSOPT_PACK_INVAL_ATTRS;
    // SAFETY: the attribute list and buffer are valid for the size given.
    let rc = unsafe {
        libc::getattrlistat(
            dir,
            name.as_ptr(),
            (&raw mut list).cast(),
            buf.as_mut_ptr().cast(),
            std::mem::size_of::<Buf>(),
            options as libc::c_ulong,
        )
    };
    // SAFETY: zeroed is a valid value of the struct; the call filled it on success.
    let buf = unsafe { buf.assume_init() };
    let returned = buf.returned;
    if rc != 0 || returned.commonattr & libc::ATTR_CMN_ADDEDTIME == 0 {
        return None;
    }
    let time = buf.time;
    Some(ns(time.tv_sec, time.tv_nsec))
}

#[cfg(not(target_os = "macos"))]
pub fn added_at(_dir: RawFd, _name: &CStr) -> Option<i128> {
    None
}

/// The value of an extended attribute of the place at `path`, not following a link; `None` when
/// it has none by that name.
#[cfg(target_os = "macos")]
pub fn xattr(path: &CStr, name: &CStr) -> Option<Vec<u8>> {
    const NOFOLLOW: libc::c_int = 0x0001;
    let mut buf = vec![0u8; 4096];
    loop {
        // SAFETY: valid C strings and a buffer of the given length.
        let n = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                NOFOLLOW,
            )
        };
        if n >= 0 {
            buf.truncate(n as usize);
            return Some(buf);
        }
        if last_errno() != libc::ERANGE || buf.len() >= 1 << 20 {
            return None;
        }
        buf.resize(buf.len() * 4, 0);
    }
}

/// The names of the extended attributes of the place at `path`, not following a link.
#[cfg(target_os = "macos")]
pub fn xattr_names(path: &CStr) -> Vec<Vec<u8>> {
    const NOFOLLOW: libc::c_int = 0x0001;
    let mut buf = vec![0u8; 1024];
    loop {
        // SAFETY: a valid C string and a buffer of the given length.
        let n =
            unsafe { libc::listxattr(path.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), NOFOLLOW) };
        if n >= 0 {
            buf.truncate(n as usize);
            return buf
                .split(|b| *b == 0)
                .filter(|n| !n.is_empty())
                .map(<[u8]>::to_vec)
                .collect();
        }
        if last_errno() != libc::ERANGE || buf.len() >= 1 << 20 {
            return Vec::new();
        }
        buf.resize(buf.len() * 4, 0);
    }
}

/// The path the system knows an open descriptor by, in the case the volume keeps.
#[cfg(target_os = "macos")]
pub fn path_of(fd: RawFd) -> Option<std::path::PathBuf> {
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes into the buffer.
    if unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr()) } != 0 {
        return None;
    }
    let len = buf.iter().position(|b| *b == 0)?;
    buf.truncate(len);
    Some(std::path::PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

/// The name of the file system the descriptor is on (`apfs`, `hfs`, `msdos`, `ext4`…).
pub fn fs_type(fd: RawFd) -> Option<String> {
    let mut st = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a valid descriptor and out pointer.
    if unsafe { libc::fstatfs(fd, st.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: fstatfs succeeded and filled the struct.
    let st = unsafe { st.assume_init() };
    #[cfg(target_os = "macos")]
    {
        let name: Vec<u8> = st
            .f_fstypename
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        String::from_utf8(name).ok()
    }
    #[cfg(target_os = "linux")]
    {
        Some(format!("{:x}", st.f_type))
    }
}

/// Placeholders are never fetched by this process, so no glance, overview or listing can make a
/// sync provider download anything; `Fetching` lifts that for one thread while it lives.
#[cfg(target_os = "macos")]
mod fetch {
    unsafe extern "C" {
        fn setiopolicy_np(
            iotype: libc::c_int,
            scope: libc::c_int,
            policy: libc::c_int,
        ) -> libc::c_int;
    }
    const MATERIALIZE_DATALESS_FILES: libc::c_int = 3;
    const PROCESS: libc::c_int = 0;
    const THREAD: libc::c_int = 1;
    const DEFAULT: libc::c_int = 0;
    const OFF: libc::c_int = 1;
    const ON: libc::c_int = 2;

    fn set(scope: libc::c_int, policy: libc::c_int) {
        // SAFETY: a plain system call with constant arguments.
        unsafe { setiopolicy_np(MATERIALIZE_DATALESS_FILES, scope, policy) };
    }

    pub fn forbid_for_process() {
        set(PROCESS, OFF);
    }

    pub struct Fetching(());

    impl Fetching {
        pub fn start() -> Fetching {
            set(THREAD, ON);
            Fetching(())
        }
    }

    impl Drop for Fetching {
        fn drop(&mut self) {
            set(THREAD, DEFAULT);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod fetch {
    pub fn forbid_for_process() {}

    pub struct Fetching(());

    impl Fetching {
        pub fn start() -> Fetching {
            Fetching(())
        }
    }
}

pub use fetch::{Fetching, forbid_for_process as forbid_fetching};
