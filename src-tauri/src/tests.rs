//! Unit tests for the core backend functions.
//!
//! Included from `lib.rs` via `#[cfg(test)] #[path = "tests.rs"] mod tests;`
//! so this module has access to all private items of the parent module.

use super::*;
use std::path::PathBuf;
use std::sync::Arc;

// ─── Helpers ────────────────────────────────────────────────────────────────

fn file_node(name: &str, path: &str, size: u64) -> FileNode {
    FileNode {
        name: Arc::from(name),
        path: Arc::from(path),
        size,
        is_dir: false,
        dir_count: 0,
        file_count: 1,
        children: Vec::new(),
    }
}

fn dir_node(
    name: &str,
    path: &str,
    size: u64,
    dir_count: usize,
    file_count: usize,
    children: Vec<FileNode>,
) -> FileNode {
    FileNode {
        name: Arc::from(name),
        path: Arc::from(path),
        size,
        is_dir: true,
        dir_count,
        file_count,
        children,
    }
}

// ─── serialize_to_binary ────────────────────────────────────────────────────

#[cfg(test)]
mod serialize_to_binary {
    use super::*;

    #[test]
    fn serializes_file_node_without_children_count() {
        let node = file_node("a.txt", "C:/x/a.txt", 100);

        let mut buf = Vec::new();
        node.serialize_to_binary(&mut buf);

        // [is_dir=0] [size=100 u64 LE] [dir_count=0 u32] [file_count=1 u32]
        // [name_len=5 u16] "a.txt" [path_len=10 u16] "C:/x/a.txt"
        let mut expected = Vec::new();
        expected.push(0u8);
        expected.extend_from_slice(&100u64.to_le_bytes());
        expected.extend_from_slice(&0u32.to_le_bytes());
        expected.extend_from_slice(&1u32.to_le_bytes());
        expected.extend_from_slice(&5u16.to_le_bytes());
        expected.extend_from_slice(b"a.txt");
        expected.extend_from_slice(&10u16.to_le_bytes());
        expected.extend_from_slice(b"C:/x/a.txt");

        assert_eq!(buf, expected);
    }

    #[test]
    fn serializes_dir_with_children_count_and_recurses() {
        let child = file_node("a.rs", "src/a.rs", 42);
        let node = dir_node("src", "src", 42, 1, 1, vec![child]);

        let mut buf = Vec::new();
        node.serialize_to_binary(&mut buf);

        let mut expected = Vec::new();
        expected.push(1u8); // is_dir
        expected.extend_from_slice(&42u64.to_le_bytes());
        expected.extend_from_slice(&1u32.to_le_bytes()); // dir_count
        expected.extend_from_slice(&1u32.to_le_bytes()); // file_count
        expected.extend_from_slice(&3u16.to_le_bytes());
        expected.extend_from_slice(b"src");
        expected.extend_from_slice(&3u16.to_le_bytes());
        expected.extend_from_slice(b"src");
        expected.extend_from_slice(&1u32.to_le_bytes()); // children_count

        // child file: "a.rs" size 42
        expected.push(0u8);
        expected.extend_from_slice(&42u64.to_le_bytes());
        expected.extend_from_slice(&0u32.to_le_bytes());
        expected.extend_from_slice(&1u32.to_le_bytes());
        expected.extend_from_slice(&4u16.to_le_bytes());
        expected.extend_from_slice(b"a.rs");
        expected.extend_from_slice(&8u16.to_le_bytes());
        expected.extend_from_slice(b"src/a.rs");

        assert_eq!(buf, expected);
    }

    #[test]
    fn serializes_empty_dir_with_zero_children() {
        let node = dir_node("empty", "empty", 0, 1, 0, vec![]);

        let mut buf = Vec::new();
        node.serialize_to_binary(&mut buf);

        let mut expected = Vec::new();
        expected.push(1u8);
        expected.extend_from_slice(&0u64.to_le_bytes());
        expected.extend_from_slice(&1u32.to_le_bytes());
        expected.extend_from_slice(&0u32.to_le_bytes());
        expected.extend_from_slice(&5u16.to_le_bytes());
        expected.extend_from_slice(b"empty");
        expected.extend_from_slice(&5u16.to_le_bytes());
        expected.extend_from_slice(b"empty");
        expected.extend_from_slice(&0u32.to_le_bytes()); // children_count

        assert_eq!(buf, expected);
    }

    #[test]
    fn serializes_utf8_names_using_byte_length() {
        // "č" is 2 bytes in UTF-8
        let node = file_node("č", "č", 7);

        let mut buf = Vec::new();
        node.serialize_to_binary(&mut buf);

        assert_eq!(buf[0], 0); // is_dir
        // name_len sits at offset 17..19: 1 (is_dir) + 8 (size) + 4 + 4
        let name_len = u16::from_le_bytes([buf[17], buf[18]]);
        assert_eq!(name_len, 2);
        assert_eq!(&buf[19..21], "č".as_bytes());
    }
}

// ─── build_dir_node ──────────────────────────────────────────────────────────

#[cfg(test)]
mod build_dir_node {
    use super::*;

    #[test]
    fn sums_sizes_and_counts_from_children() {
        let children = vec![
            file_node("a.bin", "/tmp/a.bin", 100),
            file_node("b.bin", "/tmp/b.bin", 50),
            dir_node("sub", "/tmp/sub", 30, 1, 2, vec![]),
        ];
        let node = build_dir_node(PathBuf::from("/tmp"), children);

        assert_eq!(node.size, 180); // 100 + 50 + 30
        assert_eq!(node.dir_count, 2); // 0 + 0 + (sub.dir_count=1) + 1 (self)
        assert_eq!(node.file_count, 4); // 1 + 1 + 2
        assert!(node.is_dir);
        assert_eq!(node.name.as_ref(), "tmp");
        assert_eq!(node.path.as_ref(), "/tmp");
    }

    #[test]
    fn derives_name_from_last_path_component() {
        let node = build_dir_node(PathBuf::from("/mnt/data/pictures"), vec![]);
        assert_eq!(node.name.as_ref(), "pictures");
    }

    #[test]
    fn uses_full_path_when_no_file_name() {
        let node = build_dir_node(PathBuf::from("/"), vec![]);
        assert_eq!(node.name.as_ref(), "/");
    }
}

// ─── merge_small_files ───────────────────────────────────────────────────────

#[cfg(test)]
mod merge_small_files {
    use super::*;

    #[test]
    fn merges_small_files_into_super_small_node() {
        let mut dir = dir_node(
            "d",
            "/d",
            0,
            1,
            2,
            vec![
                file_node("small.dat", "/d/small.dat", 30),
                file_node("large.dat", "/d/large.dat", 200),
            ],
        );
        merge_small_files(&mut dir, 100);

        let names: Vec<String> = dir.children.iter().map(|c| c.name.to_string()).collect();
        assert_eq!(names, vec!["large.dat", "__super_small_files__"]);

        let merged = dir
            .children
            .iter()
            .find(|c| c.name.as_ref() == "__super_small_files__")
            .unwrap();
        assert_eq!(merged.size, 30);
        assert_eq!(merged.file_count, 1);
        assert!(!merged.is_dir);
    }

    #[test]
    fn keeps_large_files_without_creating_merge_node() {
        let mut dir = dir_node(
            "d",
            "/d",
            0,
            1,
            2,
            vec![
                file_node("a.bin", "/d/a.bin", 150),
                file_node("b.bin", "/d/b.bin", 250),
            ],
        );
        merge_small_files(&mut dir, 100);

        assert_eq!(dir.children.len(), 2);
        assert!(dir
            .children
            .iter()
            .all(|c| c.name.as_ref() != "__super_small_files__"));
    }

    #[test]
    fn recurses_into_subdirectories() {
        let sub = dir_node(
            "sub",
            "/d/sub",
            0,
            1,
            1,
            vec![file_node("tiny", "/d/sub/tiny", 10)],
        );
        let mut root = dir_node("d", "/d", 0, 2, 1, vec![sub]);
        merge_small_files(&mut root, 100);

        let sub_after = &root.children[0];
        assert_eq!(sub_after.children.len(), 1);
        assert_eq!(sub_after.children[0].name.as_ref(), "__super_small_files__");
        assert_eq!(sub_after.children[0].size, 10);
    }

    #[test]
    fn merges_all_small_files_and_sums_size_and_count() {
        let mut dir = dir_node(
            "d",
            "/d",
            0,
            1,
            3,
            vec![
                file_node("a", "/d/a", 10),
                file_node("b", "/d/b", 20),
                file_node("c", "/d/c", 30),
            ],
        );
        merge_small_files(&mut dir, 100);

        assert_eq!(dir.children.len(), 1);
        let merged = &dir.children[0];
        assert_eq!(merged.name.as_ref(), "__super_small_files__");
        assert_eq!(merged.size, 60);
        assert_eq!(merged.file_count, 3);
    }

    #[test]
    fn never_merges_directories_even_if_small() {
        let mut dir = dir_node(
            "d",
            "/d",
            0,
            2,
            0,
            vec![dir_node("tiny-dir", "/d/tiny-dir", 5, 1, 0, vec![])],
        );
        merge_small_files(&mut dir, 100);

        assert_eq!(dir.children.len(), 1);
        assert_eq!(dir.children[0].name.as_ref(), "tiny-dir");
        assert!(dir.children[0].is_dir);
    }
}

// ─── normalize_paths ─────────────────────────────────────────────────────────

#[cfg(test)]
mod normalize_paths {
    use super::*;

    #[test]
    fn converts_backslashes_to_forward_slashes() {
        let mut node = dir_node("test", r"C:\Users\test", 0, 1, 0, vec![]);
        normalize_paths(&mut node);
        assert_eq!(node.path.as_ref(), "C:/Users/test");
    }

    #[test]
    fn reconstructs_file_paths_from_parent_and_name() {
        let mut node = dir_node(
            "test",
            "C:/Users/test",
            0,
            1,
            1,
            vec![file_node("a.txt", "", 5)],
        );
        normalize_paths(&mut node);
        assert_eq!(node.children[0].path.as_ref(), "C:/Users/test/a.txt");
    }

    #[test]
    fn handles_nested_directories_recursively() {
        let sub = dir_node("sub", r"C:\x\sub", 0, 1, 0, vec![]);
        let mut root = dir_node("x", r"C:\x", 0, 2, 0, vec![sub]);
        normalize_paths(&mut root);

        assert_eq!(root.path.as_ref(), "C:/x");
        assert_eq!(root.children[0].path.as_ref(), "C:/x/sub");
    }

    #[test]
    fn preserves_existing_forward_slash_paths() {
        let mut node = dir_node("x", "C:/x/y", 0, 1, 0, vec![]);
        normalize_paths(&mut node);
        assert_eq!(node.path.as_ref(), "C:/x/y");
    }
}

// ─── is_protected_path ───────────────────────────────────────────────────────

#[cfg(test)]
mod is_protected_path {
    use super::*;
    use std::path::Path;

    #[test]
    fn protects_windows_system_paths() {
        assert!(is_protected_path(Path::new(r"C:\Windows")));
        assert!(is_protected_path(Path::new(r"C:\Program Files")));
        assert!(is_protected_path(Path::new(r"C:\Users")));
        assert!(is_protected_path(Path::new(r"C:\ProgramData")));
    }

    #[test]
    fn protects_linux_system_paths() {
        assert!(is_protected_path(Path::new("/etc")));
        assert!(is_protected_path(Path::new("/usr")));
        assert!(is_protected_path(Path::new("/proc")));
        assert!(is_protected_path(Path::new("/home")));
    }

    #[test]
    fn protects_root_paths() {
        assert!(is_protected_path(Path::new("C:\\")));
        assert!(is_protected_path(Path::new("/")));
    }

    #[test]
    fn compares_case_insensitively() {
        assert!(is_protected_path(Path::new(r"c:\WINDOWS")));
        assert!(is_protected_path(Path::new(r"C:\programdata")));
    }

    #[test]
    fn allows_non_protected_paths() {
        assert!(!is_protected_path(Path::new(r"C:\Users\me\Documents")));
        assert!(!is_protected_path(Path::new("/home/user/Downloads")));
        assert!(!is_protected_path(Path::new(r"C:\Data\MyProject")));
    }
}

// ─── is_protected_path_with_extra (home dir protection) ──────────────────────

#[cfg(test)]
mod is_protected_path_with_extra {
    use super::*;
    use std::path::Path;

    fn extra_paths() -> Vec<PathBuf> {
        // Hermetic mock "home" paths — not the CI runner's real home dir.
        vec![
            PathBuf::from(r"C:\Users\testuser"),
            PathBuf::from(r"C:\Users\testuser\Desktop"),
            PathBuf::from(r"C:\Users\testuser\Documents"),
        ]
    }

    #[test]
    fn protects_mocked_home_dir() {
        let extra = extra_paths();
        assert!(is_protected_path_with_extra(Path::new(r"C:\Users\testuser"), &extra));
        assert!(is_protected_path_with_extra(Path::new(r"C:\Users\testuser\Desktop"), &extra));
        assert!(is_protected_path_with_extra(Path::new(r"C:\Users\testuser\Documents"), &extra));
    }

    #[test]
    fn protects_mocked_home_dir_case_insensitively_and_with_slashes() {
        let extra = extra_paths();
        assert!(is_protected_path_with_extra(Path::new(r"c:\USERS\TestUser"), &extra));
        assert!(is_protected_path_with_extra(Path::new("C:/Users/testuser"), &extra));
    }

    #[test]
    fn does_not_protect_unlisted_subfolders_of_mocked_home() {
        let extra = extra_paths();
        // Full equality only — subfolders of home are NOT protected unless listed,
        // so the user can still delete e.g. C:\Users\testuser\Downloads.
        assert!(!is_protected_path_with_extra(Path::new(r"C:\Users\testuser\Downloads"), &extra));
    }

    #[test]
    fn still_protects_base_system_paths_without_extra() {
        assert!(is_protected_path_with_extra(Path::new(r"C:\Windows"), &[]));
        assert!(is_protected_path_with_extra(Path::new("/etc"), &[]));
    }
}

// ─── scan_directory_core (DFS stack alignment) ───────────────────────────────

#[cfg(test)]
mod scan_directory_core {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Isolated temp scan root with cleanup on drop.
    struct TempScanDir(PathBuf);

    impl TempScanDir {
        fn new(stem: &str) -> Self {
            let base = std::env::temp_dir();
            // Unique dir per test run.
            let unique = format!(
                "scanner-core-test-{}-{}",
                stem,
                std::process::id()
            );
            let path = base.join(&unique);
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp scan root");
            TempScanDir(path)
        }

        fn join(&self, p: &str) -> PathBuf {
            self.0.join(p)
        }
    }

    impl Drop for TempScanDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scan(root: &PathBuf) -> Option<FileNode> {
        let mut running_total: u64 = 0;
        let mut denied_paths: HashSet<String> = HashSet::new();
        let mut progress: Vec<(String, u64)> = Vec::new();
        let tree = scan_directory_core(
            root,
            &mut running_total,
            &mut denied_paths,
            &mut |p: &str, sz: u64| progress.push((p.to_string(), sz)),
        );
        // Nothing to assert on progress here — just keep it alive and silent.
        let _ = progress.len();
        tree
    }

    #[test]
    fn reconstructs_nested_empty_dir_hierarchy() {
        let t = TempScanDir::new("empty-nested");
        fs::create_dir_all(t.join("a/b/c")).expect("create nested empty dirs");

        let tree = scan(&t.0).expect("scan should return a tree");
        assert!(tree.is_dir);
        assert_eq!(tree.dir_count, 4); // self + 3 nested dirs (a, b, c)
        assert_eq!(tree.file_count, 0);

        // Verify nesting: root -> a -> b -> c
        assert_eq!(tree.children.len(), 1);
        let a = &tree.children[0];
        assert!(a.is_dir);
        assert_eq!(a.dir_count, 3); // self + b + c
        assert_eq!(a.file_count, 0);
        assert_eq!(a.children.len(), 1);
        let b = &a.children[0];
        assert!(b.is_dir);
        assert_eq!(b.dir_count, 2); // self + c
        assert_eq!(b.children.len(), 1);
        let c = &b.children[0];
        assert!(c.is_dir);
        assert_eq!(c.dir_count, 1); // self only (leaf empty dir)
        assert!(c.children.is_empty());
    }

    #[test]
    fn handles_dir_with_only_subdirs_no_direct_files() {
        let t = TempScanDir::new("dirs-only");
        fs::create_dir_all(t.join("sub1")).expect("create sub1");
        fs::create_dir_all(t.join("sub2")).expect("create sub2");
        fs::create_dir_all(t.join("sub1/deep")).expect("create sub1/deep");

        let tree = scan(&t.0).expect("scan should return a tree");
        assert!(tree.is_dir);
        // dirs: self + sub1 + sub2 + sub1/deep = 4
        assert_eq!(tree.dir_count, 4);
        assert_eq!(tree.file_count, 0);
        assert_eq!(tree.children.len(), 2);

        let mut names: Vec<String> = tree.children.iter().map(|c| c.name.to_string()).collect();
        names.sort();
        assert_eq!(names, vec!["sub1", "sub2"]);

        let sub1 = tree.children.iter().find(|c| c.name.as_ref() == "sub1").unwrap();
        assert_eq!(sub1.dir_count, 2); // self + deep
        assert_eq!(sub1.children.len(), 1);
        assert_eq!(sub1.children[0].name.as_ref(), "deep");
        assert_eq!(sub1.children[0].dir_count, 1);
    }

    #[test]
    fn sums_file_counts_and_sizes_correctly() {
        let t = TempScanDir::new("files-and-dirs");
        fs::create_dir_all(t.join("sub")).expect("create sub");
        fs::write(t.join("root.txt"), b"12345").expect("write root file");
        fs::write(t.join("sub/inner.txt"), b"1234567890").expect("write inner file");

        let tree = scan(&t.0).expect("scan should return a tree");
        assert!(tree.is_dir);
        assert_eq!(tree.dir_count, 2); // self + sub
        assert_eq!(tree.file_count, 2);
        assert_eq!(tree.size, 15);
    }
}

// ─── config defaults ─────────────────────────────────────────────────────────

#[cfg(test)]
mod config {
    use super::*;

    #[test]
    fn logging_config_defaults_to_true() {
        let cfg = LoggingConfig::default();
        assert!(cfg.permission_errors);
        assert!(cfg.internal_errors);
    }

    #[test]
    fn app_config_defaults() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.total_commander_path, None);
        assert_eq!(cfg.backend_merge_threshold_kb, None);
        let logging = cfg.logging.expect("logging config should default to Some");
        assert!(logging.permission_errors);
        assert!(logging.internal_errors);
    }

    #[test]
    fn default_true_returns_true() {
        assert!(default_true());
    }
}