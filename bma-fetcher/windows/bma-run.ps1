# ตัวส่งข้อมูลเซ็นเซอร์ กทม. สำหรับ Windows (เรียกจาก start-bma.bat)
# - ตรวจ/ติดตั้ง Node.js · ดาวน์โหลด bma-fetch.mjs ล่าสุด · ถาม token ครั้งแรกแล้วเก็บแบบเข้ารหัส (DPAPI เฉพาะผู้ใช้นี้)
# - กันคอมหลับระหว่างทำงาน (จอดับได้) · ส่งข้อมูลทุก 15 นาที · เลือกให้เริ่มเองตอนเปิดเครื่องได้
param([string]$Launcher = '', [switch]$Reset)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = 'น้ำท่วม กทม. - ส่งข้อมูลเซ็นเซอร์ (อย่าปิดหน้าต่างนี้)'
$Dir = Join-Path $env:LOCALAPPDATA 'bkk-flood-bma'
$Js = Join-Path $Dir 'bma-fetch.mjs'
$Tok = Join-Path $Dir 'token.dat'
$Raw = 'https://raw.githubusercontent.com/apichaetth/bkk-flood-map/main/scripts/bma-fetch.mjs'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# เปิดได้ทีละหน้าต่าง: ถ้ามีตัวส่งข้อมูลทำงานอยู่แล้ว (เช่น เปิดเองตอนเปิดคอม แล้วดับเบิลคลิกซ้ำ) ให้ปิดตัวใหม่
$Mtx = New-Object System.Threading.Mutex($false, 'Local\bkk-flood-bma-relay')
$got = $false
try { $got = $Mtx.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }  # ตัวก่อนถูกปิดกลางคัน
if (-not $got) {
  Write-Host 'มีหน้าต่างส่งข้อมูลทำงานอยู่แล้ว ไม่ต้องเปิดซ้ำ (หน้าต่างนี้จะปิดเอง)' -ForegroundColor Yellow
  Start-Sleep -Seconds 6
  exit 0
}
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

# 1) Node.js 18+
function NodeOk { try { $v = (& node -v) 2>$null; return ($v -match '^v(\d+)' -and [int]$Matches[1] -ge 18) } catch { return $false } }
if (-not (NodeOk)) {
  Say 'ยังไม่มี Node.js (ต้องใช้ในการดึงข้อมูล)' Yellow
  $a = Read-Host 'ติดตั้ง Node.js ให้อัตโนมัติไหม? พิมพ์ Y แล้วกด Enter'
  if ($a -match '^[yY]') {
    try { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements }
    catch { Say 'ติดตั้งอัตโนมัติไม่ได้' Red }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  if (-not (NodeOk)) {
    Say 'กรุณาติดตั้ง Node.js รุ่น LTS จากหน้าเว็บที่เปิดขึ้นมา แล้วดับเบิลคลิกไฟล์นี้อีกครั้ง' Yellow
    Start-Process 'https://nodejs.org/'
    exit 1
  }
}
Say ('Node.js ' + (& node -v)) DarkGray

# 2) สคริปต์ล่าสุด (ออฟไลน์ใช้สำเนาเดิม)
try { Invoke-WebRequest -UseBasicParsing $Raw -OutFile $Js; Say 'อัปเดตสคริปต์เป็นรุ่นล่าสุดแล้ว' DarkGray }
catch { if (-not (Test-Path $Js)) { Say 'ดาวน์โหลดสคริปต์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่' Red; exit 1 } else { Say 'ออฟไลน์: ใช้สคริปต์เดิมในเครื่อง' Yellow } }

# 3) token (เก็บเข้ารหัสด้วยบัญชี Windows นี้ ถอดได้เฉพาะผู้ใช้นี้บนเครื่องนี้)
if ($Reset -and (Test-Path $Tok)) { Remove-Item $Tok }
$first = -not (Test-Path $Tok)
if ($first) {
  Say ''
  Say 'ครั้งแรก: วาง GitHub token (ตัวเดียวกับที่ใช้อยู่) แล้วกด Enter' Cyan
  Say '(ตัวอักษรจะไม่แสดงบนจอ คลิกขวาในหน้าต่างเพื่อวาง)' DarkGray
  $s = Read-Host 'Token' -AsSecureString
  if ($s.Length -lt 10) { Say 'token สั้นเกินไป ลองใหม่' Red; exit 1 }
  $s | ConvertFrom-SecureString | Set-Content -Path $Tok
}
$sec = Get-Content $Tok | ConvertTo-SecureString
$env:GH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

# ทดสอบ 1 ครั้งก่อนเริ่มวน (ครั้งแรกเท่านั้น)
if ($first) {
  Say 'ทดสอบส่งข้อมูล 1 ครั้ง...' Cyan
  & node $Js
  if ($LASTEXITCODE -ne 0) {
    Say 'ทดสอบไม่ผ่าน: ตรวจว่า token ถูกต้อง และคอมไม่ได้เปิด VPN อยู่ (ดับเบิลคลิกใหม่เพื่อลองอีกครั้ง)' Red
    Remove-Item $Tok; exit 1
  }
  # 4) เริ่มเองตอนเปิดเครื่อง
  if ($Launcher -and (Test-Path $Launcher)) {
    $a = Read-Host 'ให้เริ่มส่งข้อมูลเองทุกครั้งที่เปิดคอมไหม? พิมพ์ Y แล้วกด Enter'
    if ($a -match '^[yY]') {
      $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'BKK flood BMA relay.lnk'
      $w = New-Object -ComObject WScript.Shell; $sc = $w.CreateShortcut($lnk)
      $sc.TargetPath = $Launcher; $sc.WorkingDirectory = Split-Path $Launcher; $sc.WindowStyle = 7; $sc.Save()
      Say 'ตั้งค่าแล้ว: เปิดคอมครั้งหน้าจะเริ่มเอง (ย่อหน้าต่างไว้ที่แถบงาน)' Green
    }
  }
}

# 5) กันคอมเข้าโหมดหลับระหว่างที่หน้าต่างนี้เปิดอยู่ (จอยังดับได้ตามปกติ)
Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[Win.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

Say ''
Say 'กำลังส่งข้อมูลทุก 15 นาที · ย่อหน้าต่างนี้ไว้ได้ แต่อย่าปิด · ปิด = หยุดส่ง' Green
Say ''
if ($env:BMA_ONCE) { & node $Js } else { & node $Js --loop 15 }  # BMA_ONCE = ทดสอบรอบเดียว
