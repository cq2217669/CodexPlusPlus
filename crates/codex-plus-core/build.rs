use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", directory.display()));
    for entry in entries {
        let path = entry
            .unwrap_or_else(|error| panic!("failed to read asset entry: {error}"))
            .path();
        if path.is_dir() {
            collect_files(&path, files);
        } else {
            files.push(path);
        }
    }
}

fn update_hash(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(1_099_511_628_211)
    })
}

fn main() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo should set CARGO_MANIFEST_DIR"),
    );
    let asset_dir = manifest_dir.join("../../assets/inject");
    let mut files = Vec::new();
    collect_files(&asset_dir, &mut files);
    files.sort();

    let mut hash = 14_695_981_039_346_656_037_u64;
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        let relative_path = path
            .strip_prefix(&asset_dir)
            .expect("injection asset should remain below its root");
        hash = update_hash(hash, relative_path.to_string_lossy().as_bytes());
        let content = fs::read(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        hash = update_hash(hash, &content);
    }
    println!("cargo:rustc-env=CODEX_PLUS_INJECT_ASSET_REVISION={hash:016x}");
}
