; Manual preview updates never terminate processes by their executable name.
; Tauri's pinned NSIS template includes utils.nsh before this file, so replace
; its image-name termination macro for both install and uninstall. A name match
; conservatively blocks installation; it is never proof of process ownership.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  Push $R0
  nsis_tauri_utils::FindProcessCurrentUser "${executableName}"
  Pop $R0
  ${If} $R0 = 0
    IfSilent +2 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Close ${productName} before installing or uninstalling. StakeMode does not terminate running applications automatically."
    Pop $R0
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $R0
!macroend

!macro StakeModeCheckSidecar
  Push $R0
  nsis_tauri_utils::FindProcessCurrentUser "stakemode-sidecar.exe"
  Pop $R0
  ${If} $R0 = 0
    IfSilent +2 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Close StakeMode and wait for its local service to exit before installing or uninstalling. No running service will be terminated automatically."
    Pop $R0
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $R0
!macroend

; Interactive reinstall can invoke an older uninstaller before PREINSTALL.
; MUI calls this function before the reinstall page is reachable, so the old
; installer is never asked to stop a currently running StakeMode instance.
!define MUI_CUSTOMFUNCTION_GUIINIT StakeModeInstallerGuiInit
Function StakeModeInstallerGuiInit
  !insertmacro CheckIfAppIsRunning "stakemode.exe" "StakeMode"
  !insertmacro StakeModeCheckSidecar
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StakeModeCheckSidecar
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StakeModeCheckSidecar
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ClearErrors
  ${GetOptions} $CMDLINE "/AMATTEMPT=" $R0
  ${IfNot} ${Errors}
    StrLen $R1 $R0
    ${If} $R1 != 32
      Abort
    ${EndIf}

    StrCpy $R2 0
    stakemode_attempt_character:
      StrCpy $R3 $R0 1 $R2
      ${StrLoc} $R4 "0123456789abcdef" $R3 ">"
      ${If} $R4 == ""
        Abort
      ${EndIf}
      IntOp $R2 $R2 + 1
      IntCmp $R2 32 stakemode_attempt_valid stakemode_attempt_character stakemode_attempt_invalid

    stakemode_attempt_invalid:
      Abort

    stakemode_attempt_valid:
      ClearErrors
      FileOpen $R1 "$INSTDIR\.stakemode-update-$R0.complete" w
      ${If} ${Errors}
        Abort
      ${EndIf}
      FileWrite $R1 "${VERSION}$\r$\n"
      FileClose $R1
      ${If} ${Errors}
        Abort
      ${EndIf}
  ${EndIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
