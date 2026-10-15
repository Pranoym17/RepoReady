; Uses Tauri's upstream NSIS template. No custom recursive deletion, installer process,
; prerequisite download, registry manipulation, or state removal is added here.
; Actual installer/runtime testing is deferred until the owner approves a clean test device.
!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Restrict the initial installer to its exact per-user product directory. This also
; prevents install/state overlap. Custom destination support needs its own device tests.
!macro REPOREADY_GUARD_INSTALL_ROOT
  Push $0
  Push $1
  Push $2
  GetFullPathName $0 "$INSTDIR"
  GetFullPathName $1 "$LOCALAPPDATA\${PRODUCTNAME}"
  ${If} $0 != $1
    MessageBox MB_ICONSTOP "This installer supports only its default per-user application folder. Application installation stopped."
    Abort
  ${EndIf}
  ; Check every existing ancestor for a reparse point before files are changed.
  ${DoWhile} $0 != ""
    System::Call 'kernel32::GetFileAttributesW(w r0) i .r2'
    ${If} $2 != -1
      IntOp $2 $2 & 1024
      ${If} $2 != 0
        MessageBox MB_ICONSTOP "Installation through a reparse point is not supported. Application installation stopped."
        Abort
      ${EndIf}
    ${EndIf}
    ${GetParent} "$0" $1
    ${If} $0 == $1
      ${Break}
    ${EndIf}
    StrCpy $0 $1
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro REPOREADY_GUARD_INSTALL_ROOT
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro REPOREADY_GUARD_INSTALL_ROOT
  ; Tauri exposes this checkbox. Its built-in state deletion uses recursive removal;
  ; reject the destructive choice until owned-root deletion has real device evidence.
  ; Leaving it unchecked retains Library, settings, logs and all user-generated data.
  ${If} $DeleteAppDataCheckboxState = 1
    MessageBox MB_ICONSTOP "Removing saved state is not supported in this development build. Uncheck 'Delete app data' to uninstall and retain your Library and settings."
    Abort
  ${EndIf}
!macroend
