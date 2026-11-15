; GameBrowser Windows installer (Inno Setup 6).
; Build: ISCC /DAppVersion=0.1.0-preview.5 /DSourceDir=path\to\GameBrowser /DOutputDir=dist installer\GameBrowser.iss
; SourceDir must contain GameBrowser.exe plus the runtime, cloakbrowser, firefox and notices folders.

#ifndef AppVersion
  #define AppVersion "0.1.0-preview.5"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\GameBrowser"
#endif
#ifndef ExePath
  #define ExePath SourceDir + "\GameBrowser.exe"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{7E3C2A91-5B4F-4C8E-9D21-6A0F3B8C4E57}
AppName=GameBrowser
AppVersion={#AppVersion}
AppVerName=GameBrowser {#AppVersion}
AppPublisher=Solomon Gbeta
AppPublisherURL=https://solomon.ng
AppSupportURL=https://github.com/MultilancerNG/osBrowser/issues
AppUpdatesURL=https://multilancerng.github.io/osBrowser/
DefaultDirName={localappdata}\Programs\GameBrowser
DefaultGroupName=GameBrowser
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=GameBrowser-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
DiskSpanning=no
WizardStyle=modern
UninstallDisplayIcon={app}\GameBrowser.exe
UninstallDisplayName=GameBrowser
LicenseFile={#SourceDir}\notices\LICENSE
CloseApplications=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#ExePath}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\Start GameBrowser.cmd"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#SourceDir}\README-GameBrowser.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme skipifsourcedoesntexist
Source: "{#SourceDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\cloakbrowser\*"; DestDir: "{app}\cloakbrowser"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\firefox\*"; DestDir: "{app}\firefox"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\notices\*"; DestDir: "{app}\notices"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\GameBrowser"; Filename: "{app}\GameBrowser.exe"; WorkingDir: "{app}"
Name: "{group}\Uninstall GameBrowser"; Filename: "{uninstallexe}"
Name: "{autodesktop}\GameBrowser"; Filename: "{app}\GameBrowser.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\GameBrowser.exe"; Description: "Start GameBrowser now"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Profiles live in %LOCALAPPDATA%\GameBrowser and are kept on uninstall on purpose.
Type: filesandordirs; Name: "{app}\runtime"
