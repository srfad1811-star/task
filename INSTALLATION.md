# BroadcastQA Studio — Windows Desktop (.NET 8 WPF) Build & Installer Guide

## Prerequisites (Windows 10 / 11 x64)
1. Install **.NET 8 Desktop SDK**: https://dotnet.microsoft.com/download/dotnet/8.0
2. Install **Inno Setup 6** (for generating the standalone `.EXE` installer): https://jrsoftware.org/isdl.php

## Build & Publish Standalone Executable
```powershell
cd wpf-desktop
dotnet restore src/BroadcastQA.Wpf/BroadcastQA.Wpf.csproj
dotnet publish src/BroadcastQA.Wpf/BroadcastQA.Wpf.csproj `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true
```

## Build Standalone Windows Installer (.EXE)
```powershell
iscc installer/BroadcastQA.iss
```
The installer executable will be written to `wpf-desktop/dist-installer/BroadcastQAStudio_Setup_1.0.0.exe`.
Running the installer creates Desktop & Start Menu shortcuts and stores all SQLite databases, backups, and archived XML files locally under `%LOCALAPPDATA%\BroadcastQAStudio\`.
