//! Client-state removal only. No recursion, user-selected paths, application executors or documents.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
const MARKER: &str = "RepoReady native state v1\n";
const FILES: &[&str] = &[
    "owner",
    "state.sqlite",
    "state.sqlite-wal",
    "state.sqlite-shm",
    "state.sqlite-journal",
    "state.backup.sqlite",
    "state.backup.pending.sqlite",
    "events.log",
    "events.previous.log",
    "events.prune.pending",
];

fn guard(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("UNSAFE_CLEANUP_PATH".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("UNSAFE_CLEANUP_PATH".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("CLEANUP_INSPECTION_FAILED".into()),
        }
    }
    Ok(())
}
fn owned(root: &Path) -> Result<(), String> {
    guard(root)?;
    guard(&root.join("owner"))?;
    let metadata = fs::symlink_metadata(root).map_err(|_| "CLEANUP_INSPECTION_FAILED")?;
    if !metadata.is_dir()
        || fs::metadata(root.join("owner"))
            .map_err(|_| "UNOWNED_STATE_ROOT")?
            .len()
            != MARKER.len() as u64
        || fs::read(root.join("owner")).map_err(|_| "UNOWNED_STATE_ROOT")? != MARKER.as_bytes()
    {
        return Err("UNOWNED_STATE_ROOT".into());
    }
    Ok(())
}
fn inspect(root: &Path) -> Result<Vec<PathBuf>, String> {
    guard(root)?;
    match fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("CLEANUP_INSPECTION_FAILED".into()),
        Ok(_) => {}
    }
    owned(root)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "CLEANUP_INSPECTION_FAILED")? {
        let entry = entry.map_err(|_| "CLEANUP_INSPECTION_FAILED")?;
        let path = entry.path();
        guard(&path)?;
        if !entry
            .file_type()
            .map_err(|_| "CLEANUP_INSPECTION_FAILED")?
            .is_file()
            || !FILES.iter().any(|name| entry.file_name() == *name)
        {
            return Err("UNRECOGNISED_STATE_FILE".into());
        }
        files.push(path);
    }
    // The ownership marker remains until every recognised data file has been removed.
    files.sort_by_key(|path| path.file_name().is_some_and(|name| name == "owner"));
    Ok(files)
}

/// `local_app_data` comes from the Windows known-folder API in the CLI adapter, never IPC.
/// Tests supply only newly created disposable directories. Application/user data is outside scope.
pub fn remove_client_state(local_app_data: &Path, identifier: &str) -> Result<(), String> {
    if !["org.repoready.development", "io.github.pranoym17.repoready"].contains(&identifier)
        || !local_app_data.is_absolute()
        || local_app_data.parent().is_none()
        || local_app_data
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("INVALID_CLEANUP_ROOT".into());
    }
    let root = local_app_data.join(identifier);
    guard(&root)?;
    let roots = [root.join("desktop-state"), root.join("client-updates")];
    // Validate BOTH state trees completely before changing either. Unknown files fail closed.
    let plans = roots
        .iter()
        .map(|state| inspect(state))
        .collect::<Result<Vec<_>, _>>()?;
    for (state, files) in roots.iter().zip(plans) {
        if files.is_empty() {
            continue;
        }
        for file in files {
            owned(state)?;
            guard(&file)?;
            if !fs::symlink_metadata(&file)
                .map_err(|_| "CLEANUP_INSPECTION_FAILED")?
                .is_file()
            {
                return Err("UNSAFE_CLEANUP_PATH".into());
            }
            fs::remove_file(file).map_err(|_| "CLEANUP_REMOVE_FAILED")?;
        }
        fs::remove_dir(state).map_err(|_| "CLEANUP_REMOVE_FAILED")?;
    }
    // Preserve all unknown root content, including any future installed-app directories.
    if root.is_dir()
        && fs::read_dir(&root)
            .map_err(|_| "CLEANUP_INSPECTION_FAILED")?
            .next()
            .is_none()
    {
        fs::remove_dir(root).map_err(|_| "CLEANUP_REMOVE_FAILED")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(base: &Path, name: &str) {
        let root = base.join("org.repoready.development").join(name);
        let store = crate::storage::Store::open(&root).unwrap();
        store
            .log_event(crate::diagnostics::Event {
                code: crate::diagnostics::Code::Started,
                component: crate::diagnostics::Component::Desktop,
            })
            .unwrap();
    }
    #[test]
    fn removes_both_owned_stores_and_preserves_documents_apps_and_other_identity() {
        let base = tempfile::tempdir().unwrap();
        state(base.path(), "desktop-state");
        state(base.path(), "client-updates");
        let apps = base
            .path()
            .join("org.repoready.development/apps/user-project");
        fs::create_dir_all(&apps).unwrap();
        fs::write(apps.join("saved.txt"), b"preserve").unwrap();
        let stable = base.path().join("io.github.pranoym17.repoready");
        fs::create_dir_all(&stable).unwrap();
        fs::write(stable.join("saved.txt"), b"preserve").unwrap();
        remove_client_state(base.path(), "org.repoready.development").unwrap();
        assert!(
            !base
                .path()
                .join("org.repoready.development/desktop-state")
                .exists()
        );
        assert!(
            !base
                .path()
                .join("org.repoready.development/client-updates")
                .exists()
        );
        assert_eq!(fs::read(apps.join("saved.txt")).unwrap(), b"preserve");
        assert!(stable.join("saved.txt").exists());
        remove_client_state(base.path(), "org.repoready.development").unwrap();
    }
    #[test]
    fn unknown_nested_files_or_bad_marker_prevent_all_deletion() {
        for unknown in [true, false] {
            let base = tempfile::tempdir().unwrap();
            state(base.path(), "desktop-state");
            state(base.path(), "client-updates");
            let state = base.path().join("org.repoready.development/client-updates");
            if unknown {
                fs::write(state.join("user-notes.txt"), b"preserve").unwrap();
            } else {
                fs::write(state.join("owner"), b"wrong").unwrap();
            }
            assert!(remove_client_state(base.path(), "org.repoready.development").is_err());
            assert!(
                base.path()
                    .join("org.repoready.development/desktop-state/state.sqlite")
                    .exists()
            );
        }
    }
    #[test]
    fn paths_unknown_identities_and_directories_named_like_known_files_are_refused() {
        let base = tempfile::tempdir().unwrap();
        for id in ["../outside", "", "other"] {
            assert!(remove_client_state(base.path(), id).is_err());
        }
        assert!(remove_client_state(Path::new("relative"), "org.repoready.development").is_err());
        state(base.path(), "desktop-state");
        let root = base.path().join("org.repoready.development/desktop-state");
        fs::create_dir(root.join("state.sqlite-journal")).unwrap();
        assert!(remove_client_state(base.path(), "org.repoready.development").is_err());
        assert!(root.join("state.sqlite").exists());
    }
    #[cfg(unix)]
    #[test]
    fn links_cannot_redirect_cleanup_to_another_directory() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        state(outside.path(), "desktop-state");
        fs::create_dir(base.path().join("org.repoready.development")).unwrap();
        std::os::unix::fs::symlink(
            outside
                .path()
                .join("org.repoready.development/desktop-state"),
            base.path().join("org.repoready.development/desktop-state"),
        )
        .unwrap();
        assert!(remove_client_state(base.path(), "org.repoready.development").is_err());
        assert!(
            outside
                .path()
                .join("org.repoready.development/desktop-state/state.sqlite")
                .exists()
        );
    }
}
