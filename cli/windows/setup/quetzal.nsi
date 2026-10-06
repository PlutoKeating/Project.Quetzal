; Quetzal 的 Windows 安装包（NSIS 3，Unicode）。由 cli/windows/build-setup.mjs 调用 makensis 编译：
;   makensis /DVERSION=<版本> /DVIVERSION=<a.b.c.0> /DARCH=<x64|arm64> /DSTAGE=<暂存目录> /DOUTFILE=<输出> [/DICON=<.ico>] quetzal.nsi
; 以用户身份把文件装进 %LOCALAPPDATA%\Quetzal（docs/WINDOWS_DECISIONS.md 4.1），机器级的步骤（缺的 Node.js / Git / Python、
; 命令沙箱、计划任务）合进一次 UAC 提权（quetzal-machine.ps1）；装完健康检查 40 秒，不过就退回上一版。
; 命令行参数（静默安装用）：
;   /S           静默
;   /CLOSEAPPS   Quetzal 正在运行时同意先关掉它（静默模式下没有这个参数就不关、退出码 3）
;   /OPEN        装完打开控制台窗口（静默模式默认只启动托盘）
;   /ELEVATE     即使机器级步骤已就绪也重新做一遍（要 UAC）
;   /UPGRADE     从控制台发起的升级：在会话 0 里需要提权时不弹 UAC，退出码 14
; 退出码：0 成功；3 正在运行且未同意关闭；4 关不掉正在运行的进程；5 系统或架构不符；11/13 没有可用的 Node.js；
;         14 需要在这台电脑上运行一次安装；20 新版本不健康、已退回上一版；21 不健康且没有上一版；70 内部错误
; 卸载参数：/S 静默，/PURGE 连数据（home\）一起删。

Unicode true
ManifestDPIAware true
ManifestSupportedOS all
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!macro Require NAME
  !ifndef ${NAME}
    !error "需要 /D${NAME}=…（见文件开头）"
  !endif
!macroend
!insertmacro Require VERSION
!insertmacro Require VIVERSION
!insertmacro Require ARCH
!insertmacro Require STAGE
!insertmacro Require OUTFILE

!define AUMID "xyz.quetzal.console"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Quetzal"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Name "Quetzal"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Quetzal"
BrandingText "Quetzal ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VIVERSION}"
VIAddVersionKey /LANG=0 "ProductName" "Quetzal"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileDescription" "Quetzal ${VERSION} setup (${ARCH})"
VIAddVersionKey /LANG=0 "LegalCopyright" "AGPL-3.0-only"

!ifdef ICON
  !define MUI_ICON "${ICON}"
  !define MUI_UNICON "${ICON}"
!endif
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "$(TXT_WELCOME)"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(TXT_RUN)"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenConsole
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------------------------------------------------------- 文案（简繁中文系统显示中文，其余英文）
LangString TXT_WELCOME ${LANG_ENGLISH} "This installs Quetzal ${VERSION}.$\r$\n$\r$\nNode.js, Git and Python are installed too if this computer lacks them. Windows will ask once for administrator permission: for those, the command sandbox and starting at boot."
LangString TXT_WELCOME ${LANG_SIMPCHINESE} "将安装 Quetzal ${VERSION}。$\r$\n$\r$\n这台电脑缺少的 Node.js、Git、Python 会一起装上。中途 Windows 会请求一次管理员权限，用来装这些依赖、命令沙箱和开机自启。"
LangString TXT_RUN ${LANG_ENGLISH} "Open Quetzal"
LangString TXT_RUN ${LANG_SIMPCHINESE} "打开 Quetzal"
LangString TXT_OLDWIN ${LANG_ENGLISH} "Quetzal needs Windows 10 version 1809 or later."
LangString TXT_OLDWIN ${LANG_SIMPCHINESE} "Quetzal 需要 Windows 10 1809 或更新的版本。"
LangString TXT_USE_ARM64 ${LANG_ENGLISH} "This computer has an ARM64 processor. Please use the arm64 installer."
LangString TXT_USE_ARM64 ${LANG_SIMPCHINESE} "这台电脑是 ARM64 处理器，请使用 arm64 版的安装包。"
LangString TXT_USE_X64 ${LANG_ENGLISH} "This computer does not have an ARM64 processor. Please use the x64 installer."
LangString TXT_USE_X64 ${LANG_SIMPCHINESE} "这台电脑不是 ARM64 处理器，请使用 x64 版的安装包。"
LangString TXT_32BIT ${LANG_ENGLISH} "32-bit Windows is not supported."
LangString TXT_32BIT ${LANG_SIMPCHINESE} "不支持 32 位 Windows。"
LangString TXT_RUNNING ${LANG_ENGLISH} "Quetzal is running. It will be closed first (a few seconds) and started again after the installation. Continue?"
LangString TXT_RUNNING ${LANG_SIMPCHINESE} "Quetzal 正在运行。会先把它关掉（几秒钟），装好后自动重新启动。继续吗？"
LangString TXT_UN_RUNNING ${LANG_ENGLISH} "Quetzal is running and will be closed first. Continue?"
LangString TXT_UN_RUNNING ${LANG_SIMPCHINESE} "Quetzal 正在运行，卸载会先把它关掉。继续吗？"
LangString TXT_CANNOT_STOP ${LANG_ENGLISH} "Some Quetzal processes could not be closed. Restart the computer and run the installer again."
LangString TXT_CANNOT_STOP ${LANG_SIMPCHINESE} "有 Quetzal 进程关不掉。请重启电脑后再运行安装程序。"
LangString TXT_STOPPING ${LANG_ENGLISH} "Closing the running Quetzal..."
LangString TXT_STOPPING ${LANG_SIMPCHINESE} "正在关闭正在运行的 Quetzal…"
LangString TXT_DETECT ${LANG_ENGLISH} "Looking for Node.js, Git and Python..."
LangString TXT_DETECT ${LANG_SIMPCHINESE} "正在查找 Node.js、Git、Python…"
LangString TXT_MACHINE ${LANG_ENGLISH} "Installing what needs administrator permission (dependencies, command sandbox, start at boot)..."
LangString TXT_MACHINE ${LANG_SIMPCHINESE} "正在安装需要管理员权限的部分（依赖、命令沙箱、开机自启）…"
LangString TXT_UAC_DECLINED ${LANG_ENGLISH} "Administrator permission was not granted. Quetzal is installed, but the command sandbox and starting at boot are missing: commands will not run until you run the installer again."
LangString TXT_UAC_DECLINED ${LANG_SIMPCHINESE} "没有获得管理员权限。Quetzal 已装好，但命令沙箱和开机自启没有装上：在重新运行安装程序之前，她不能执行命令。"
LangString TXT_NO_NODE ${LANG_ENGLISH} "Node.js could not be installed, so Quetzal cannot run. Details: $INSTDIR\install.log"
LangString TXT_NO_NODE ${LANG_SIMPCHINESE} "Node.js 没有装上，Quetzal 无法运行。详情见 $INSTDIR\install.log"
LangString TXT_MACHINE_PARTIAL ${LANG_ENGLISH} "Some administrator steps did not complete (see $INSTDIR\install.log). Quetzal will still run; run the installer again to retry."
LangString TXT_MACHINE_PARTIAL ${LANG_SIMPCHINESE} "部分需要管理员权限的步骤没有完成（见 $INSTDIR\install.log）。Quetzal 仍可运行；重新运行安装程序可以再试。"
LangString TXT_NEED_INSTALL ${LANG_ENGLISH} "This upgrade needs administrator permission: run the installer once on this computer."
LangString TXT_NEED_INSTALL ${LANG_SIMPCHINESE} "这次升级需要管理员权限：需要在这台电脑上运行一次安装。"
LangString TXT_STARTING ${LANG_ENGLISH} "Starting Quetzal and waiting for it to respond (up to 40 seconds)..."
LangString TXT_STARTING ${LANG_SIMPCHINESE} "正在启动 Quetzal 并等它响应（最多 40 秒）…"
LangString TXT_ROLLED_BACK ${LANG_ENGLISH} "The new version did not respond within 40 seconds, so the previous version was restored. Details: $INSTDIR\install.log and $INSTDIR\home\logs\runtime.log"
LangString TXT_ROLLED_BACK ${LANG_SIMPCHINESE} "新版本没有在 40 秒内正常响应，已退回上一版。详情见 $INSTDIR\install.log 与 $INSTDIR\home\logs\runtime.log"
LangString TXT_UNHEALTHY ${LANG_ENGLISH} "Quetzal did not respond within 40 seconds. Details: $INSTDIR\install.log and $INSTDIR\home\logs\runtime.log"
LangString TXT_UNHEALTHY ${LANG_SIMPCHINESE} "Quetzal 没有在 40 秒内响应。详情见 $INSTDIR\install.log 与 $INSTDIR\home\logs\runtime.log"
LangString TXT_INTERNAL ${LANG_ENGLISH} "The installer hit an error. Details: $INSTDIR\install.log"
LangString TXT_INTERNAL ${LANG_SIMPCHINESE} "安装程序出错了。详情见 $INSTDIR\install.log"
LangString TXT_SHORTCUT_UNINSTALL ${LANG_ENGLISH} "Uninstall Quetzal"
LangString TXT_SHORTCUT_UNINSTALL ${LANG_SIMPCHINESE} "卸载 Quetzal"
LangString TXT_PURGE ${LANG_ENGLISH} "Also delete Quetzal's data on this computer (settings, memories, conversations)? What is already synced to the soul repository stays there. Choose No to keep the data."
LangString TXT_PURGE ${LANG_SIMPCHINESE} "同时删除这台电脑上 Quetzal 的数据（配置、记忆、对话）吗？已同步到灵魂仓库的内容不受影响。选「否」保留数据。"
LangString TXT_UN_UAC ${LANG_ENGLISH} "Administrator permission was not granted: the start-at-boot tasks and the command sandbox account stay on this computer. Run the uninstaller again to remove them."
LangString TXT_UN_UAC ${LANG_SIMPCHINESE} "没有获得管理员权限：开机自启的计划任务和命令沙箱账户还留在这台电脑上。再运行一次卸载即可移除。"
LangString TXT_KEPT ${LANG_ENGLISH} "Node.js, Git and Python were left installed; remove them from Settings > Apps if you do not need them."
LangString TXT_KEPT ${LANG_SIMPCHINESE} "Node.js、Git、Python 保留未动；不需要的话可以在「设置 › 应用」里卸载。"

Var PS          ; 原生（64 位 / ARM64）的 Windows PowerShell
Var CV          ; 控制台当前版本

; 安装包是 32 位程序：经 Sysnative 调到原生的 PowerShell（否则 $env:ProgramFiles 与注册表都会被重定向到 32 位视图）
!macro FindPowerShell
  StrCpy $PS "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists $PS +2 0
    StrCpy $PS "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
!macroend

; 调用 quetzal-setup.ps1 的一个动作，退出码放进 $0
!macro Helper ACTION EXTRA
  nsExec::ExecToLog '"$PS" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\quetzal-setup.ps1" -Action ${ACTION} -Root "$INSTDIR" ${EXTRA}'
  Pop $0
!macroend

!macro Fail CODE MSG
  DetailPrint "${MSG}"
  MessageBox MB_ICONSTOP|MB_OK "${MSG}" /SD IDOK
  SetErrorLevel ${CODE}
  Abort
!macroend

!macro PickLanguage
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $1 $0 & 0x3FF
  ${If} $1 = 4
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
!macroend

Function .onInit
  !insertmacro PickLanguage
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${AtLeastBuild} 17763
    MessageBox MB_ICONSTOP|MB_OK "$(TXT_OLDWIN)" /SD IDOK
    SetErrorLevel 5
    Abort
  ${EndIf}
  !if "${ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_ICONSTOP|MB_OK "$(TXT_USE_X64)" /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
  !else
    ${If} ${IsNativeARM64}
      MessageBox MB_ICONSTOP|MB_OK "$(TXT_USE_ARM64)" /SD IDOK
      SetErrorLevel 5
      Abort
    ${ElseIfNot} ${IsNativeAMD64}
      MessageBox MB_ICONSTOP|MB_OK "$(TXT_32BIT)" /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
  !endif
  StrCpy $INSTDIR "$LOCALAPPDATA\Quetzal"
FunctionEnd

Function OpenConsole
  Exec '"$INSTDIR\console\$CV\quetzal-console.exe"'
FunctionEnd

Section "Quetzal"
  SetShellVarContext current
  !insertmacro FindPowerShell
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${STAGE}\setup\quetzal-setup.ps1"
  File "${STAGE}\setup\quetzal-machine.ps1"
  CreateDirectory "$INSTDIR"
  ${GetParameters} $R0
  StrCpy $R9 ""   ; 额外参数：-Force / -Upgrade
  ClearErrors
  ${GetOptions} $R0 "/ELEVATE" $R1
  ${IfNot} ${Errors}
    StrCpy $R9 "$R9 -Force"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/UPGRADE" $R1
  ${IfNot} ${Errors}
    StrCpy $R9 "$R9 -Upgrade"
  ${EndIf}

  ; 1. 正在运行的 Quetzal（守护、运行基座、身体助手、控制台）：经同意后全部关掉，干净安装
  !insertmacro Helper Processes ""
  ${If} $0 > 0
  ${AndIf} $0 < 100
    ${If} ${Silent}
      ClearErrors
      ${GetOptions} $R0 "/CLOSEAPPS" $R1
      ${If} ${Errors}
        ClearErrors
        ${GetOptions} $R0 "/UPGRADE" $R1
      ${EndIf}
      ${If} ${Errors}
        DetailPrint "Quetzal is running; pass /CLOSEAPPS to close it"
        SetErrorLevel 3
        Abort
      ${EndIf}
    ${Else}
      MessageBox MB_ICONQUESTION|MB_OKCANCEL "$(TXT_RUNNING)" IDOK +3
        SetErrorLevel 3
        Abort
    ${EndIf}
    DetailPrint "$(TXT_STOPPING)"
    !insertmacro Helper Stop ""
    ${If} $0 != 0
      !insertmacro Fail 4 "$(TXT_CANNOT_STOP)"
    ${EndIf}
  ${EndIf}

  ; 2. 文件：运行基座、控制台、命令行入口与守护启动器（各版本共用的稳定路径）
  SetOutPath "$INSTDIR\runtime\${VERSION}"
  File /r "${STAGE}\runtime\*"
  SetOutPath "$INSTDIR\console\${VERSION}"
  File /r "${STAGE}\console\*"
  SetOutPath "$INSTDIR\bin"
  File "${STAGE}\bin\quetzal.cmd"
  File "${STAGE}\bin\quetzal-supervise.ps1"
  CreateDirectory "$INSTDIR\home"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 3. 依赖：只把缺的官方安装包解出来，机器级步骤一次提权
  DetailPrint "$(TXT_DETECT)"
  !insertmacro Helper Detect "-Version ${VERSION} -Arch ${ARCH} $R9"
  ${If} $0 > 15
    !insertmacro Fail 70 "$(TXT_INTERNAL)"
  ${EndIf}
  SetOutPath "$PLUGINSDIR\deps"
  File "${STAGE}\deps\deps.json"
  IntOp $1 $0 & 1
  ${If} $1 <> 0
    File "${STAGE}\deps\node.msi"
  ${EndIf}
  IntOp $1 $0 & 2
  ${If} $1 <> 0
    File "${STAGE}\deps\git.exe"
  ${EndIf}
  IntOp $1 $0 & 4
  ${If} $1 <> 0
    File "${STAGE}\deps\python.exe"
  ${EndIf}
  ${If} $0 <> 0
    DetailPrint "$(TXT_MACHINE)"
  ${EndIf}
  !insertmacro Helper Machine '-Version ${VERSION} -Arch ${ARCH} -Deps "$PLUGINSDIR\deps" $R9'
  ${Switch} $0
    ${Case} 0
      ${Break}
    ${Case} 10
      DetailPrint "$(TXT_UAC_DECLINED)"
      MessageBox MB_ICONEXCLAMATION|MB_OK "$(TXT_UAC_DECLINED)" /SD IDOK
      ${Break}
    ${Case} 12
      DetailPrint "$(TXT_MACHINE_PARTIAL)"
      MessageBox MB_ICONEXCLAMATION|MB_OK "$(TXT_MACHINE_PARTIAL)" /SD IDOK
      ${Break}
    ${Case} 14
      !insertmacro Fail 14 "$(TXT_NEED_INSTALL)"
      ${Break}
    ${Case} 11
    ${Case} 13
      !insertmacro Fail 13 "$(TXT_NO_NODE)"
      ${Break}
    ${Default}
      !insertmacro Fail 70 "$(TXT_INTERNAL)"
  ${EndSwitch}
  RMDir /r "$PLUGINSDIR\deps"

  ; 4. 切换指针（previous.txt ← current.txt ← 这个版本）、缺省配置、用户 PATH
  !insertmacro Helper Activate "-Version ${VERSION}"
  ${If} $0 != 0
    !insertmacro Fail 70 "$(TXT_INTERNAL)"
  ${EndIf}

  ; 5. 启动并健康检查（/health 的版本相符才算成功；40 秒不过退回上一版）
  DetailPrint "$(TXT_STARTING)"
  !insertmacro Helper Start ""
  !insertmacro Helper Health "-Version ${VERSION}"
  StrCpy $R8 $0

  ; 6. 开始菜单、卸载项、开机托盘、通知用的 AppUserModelID：指向此刻的当前版本（退回时就是上一版）
  ClearErrors
  FileOpen $2 "$INSTDIR\console\current.txt" r
  FileRead $2 $CV
  FileClose $2
  Push $CV
  Call TrimNewline
  Pop $CV
  FileOpen $2 "$INSTDIR\runtime\current.txt" r
  FileRead $2 $3
  FileClose $2
  Push $3
  Call TrimNewline
  Pop $3
  CreateDirectory "$SMPROGRAMS\Quetzal"
  CreateShortcut "$SMPROGRAMS\Quetzal\Quetzal.lnk" "$INSTDIR\console\$CV\quetzal-console.exe"
  CreateShortcut "$SMPROGRAMS\Quetzal\$(TXT_SHORTCUT_UNINSTALL).lnk" "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${RUN_KEY}" "Quetzal" '"$INSTDIR\console\$CV\quetzal-console.exe" --background'
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${AUMID}" "DisplayName" "Quetzal"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${AUMID}" "IconUri" "$INSTDIR\runtime\$3\web\icons\Icon-192.png"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Quetzal"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "$3"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Quetzal"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://quetzal.plutokeating.beer"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\console\$CV\quetzal-console.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K /G=1" $4 $5 $6
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $4

  ; 7. 托盘（它看护用户会话里的身体助手）；/OPEN 时直接打开窗口。会话 0（从控制台升级时可能如此）不启动界面
  System::Call 'kernel32::GetCurrentProcessId() i .r5'
  System::Call 'kernel32::ProcessIdToSessionId(i r5, *i .r6)'
  ${If} $6 <> 0
    ClearErrors
    ${GetOptions} $R0 "/OPEN" $R1
    ${If} ${Errors}
      Exec '"$INSTDIR\console\$CV\quetzal-console.exe" --background'
    ${Else}
      Exec '"$INSTDIR\console\$CV\quetzal-console.exe"'
    ${EndIf}
  ${EndIf}

  ${If} $R8 = 20
    !insertmacro Fail 20 "$(TXT_ROLLED_BACK)"
  ${ElseIf} $R8 = 21
    !insertmacro Fail 21 "$(TXT_UNHEALTHY)"
  ${ElseIf} $R8 != 0
    !insertmacro Fail 70 "$(TXT_INTERNAL)"
  ${EndIf}
SectionEnd

; 去掉 FileRead 读到的行尾
Function TrimNewline
  Exch $R1
  Push $R2
  loop:
    StrCpy $R2 $R1 1 -1
    ${If} $R2 == "$\r"
    ${OrIf} $R2 == "$\n"
    ${OrIf} $R2 == " "
      StrCpy $R1 $R1 -1
      Goto loop
    ${EndIf}
  Pop $R2
  Exch $R1
FunctionEnd

; ---------------------------------------------------------------- 卸载（按用户；机器级的计划任务与沙箱账户再提权一次移除）
Function un.onInit
  !insertmacro PickLanguage
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro FindPowerShell
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${STAGE}\setup\quetzal-setup.ps1"
  File "${STAGE}\setup\quetzal-machine.ps1"
  ${GetParameters} $R0

  !insertmacro Helper Processes ""
  ${If} $0 > 0
  ${AndIf} $0 < 100
    ${IfNot} ${Silent}
      MessageBox MB_ICONQUESTION|MB_OKCANCEL "$(TXT_UN_RUNNING)" IDOK +3
        SetErrorLevel 3
        Abort
    ${EndIf}
    DetailPrint "$(TXT_STOPPING)"
    !insertmacro Helper Stop ""
  ${EndIf}

  ; srt-win.exe 跟着运行基座的版本目录走：先复制出来，再提权执行 srt-win uninstall 并删掉计划任务
  FileOpen $2 "$INSTDIR\runtime\current.txt" r
  FileRead $2 $3
  FileClose $2
  Push $3
  Call un.TrimNewline
  Pop $3
  StrCpy $4 ""
  ${If} $3 != ""
  ${AndIf} ${FileExists} "$INSTDIR\runtime\$3\srt-win\srt-win.exe"
    CopyFiles /SILENT "$INSTDIR\runtime\$3\srt-win\srt-win.exe" "$PLUGINSDIR\srt-win.exe"
    StrCpy $4 '-SrtWin "$PLUGINSDIR\srt-win.exe"'
  ${EndIf}
  !insertmacro Helper MachineUninstall "$4"
  ${If} $0 = 10
    DetailPrint "$(TXT_UN_UAC)"
    MessageBox MB_ICONEXCLAMATION|MB_OK "$(TXT_UN_UAC)" /SD IDOK
  ${EndIf}
  !insertmacro Helper UninstallUser ""

  DeleteRegValue HKCU "${RUN_KEY}" "Quetzal"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\${AUMID}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  RMDir /r "$SMPROGRAMS\Quetzal"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\console"
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\logs-setup"
  Delete "$INSTDIR\node.txt"
  Delete "$INSTDIR\deps.json"
  Delete "$INSTDIR\machine.json"
  Delete "$INSTDIR\machine-result.json"
  Delete "$INSTDIR\install.log"
  Delete "$INSTDIR\uninstall.exe"

  StrCpy $5 0
  ClearErrors
  ${GetOptions} $R0 "/PURGE" $R1
  ${IfNot} ${Errors}
    StrCpy $5 1
  ${ElseIfNot} ${Silent}
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(TXT_PURGE)" IDNO +2
      StrCpy $5 1
  ${EndIf}
  ${If} $5 = 1
    RMDir /r "$INSTDIR\home"
  ${EndIf}
  RMDir "$INSTDIR"
  DetailPrint "$(TXT_KEPT)"
SectionEnd

Function un.TrimNewline
  Exch $R1
  Push $R2
  loop:
    StrCpy $R2 $R1 1 -1
    ${If} $R2 == "$\r"
    ${OrIf} $R2 == "$\n"
    ${OrIf} $R2 == " "
      StrCpy $R1 $R1 -1
      Goto loop
    ${EndIf}
  Pop $R2
  Exch $R1
FunctionEnd
