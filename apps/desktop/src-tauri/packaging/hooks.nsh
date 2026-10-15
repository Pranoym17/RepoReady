; Uses Tauri's upstream NSIS template. State deletion is delegated to the bounded native
; ownership-checked helper. Never use the upstream recursive app-data deletion.
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
  ; Preserve state during updates and by default. Only explicit data-removal consent
  ; invokes the helper, which accepts no path argument and never removes applications.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    Push $0
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --remove-client-state' $0
    ${If} ${Errors}
      Pop $0
      MessageBox MB_ICONSTOP "RepoReady could not start its saved-state cleanup. Uninstall stopped. Your applications and documents have not been selected for removal."
      Abort
    ${EndIf}
    ${If} $0 != 0
      Pop $0
      MessageBox MB_ICONSTOP "RepoReady could not safely remove all of its saved state. Unknown or locked files were preserved. Close RepoReady or uncheck 'Delete app data' and try again."
      Abort
    ${EndIf}
    Pop $0
    ; Suppress upstream RmDir /r for both roaming and local app data. The helper
    ; removes only its known state files and preserves all unknown root content.
    StrCpy $DeleteAppDataCheckboxState 0
  ${EndIf}
!macroend
