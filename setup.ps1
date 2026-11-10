<#
    PlotMatch — one-command setup for Windows.

        powershell -ExecutionPolicy Bypass -File .\setup.ps1

    What it does:
      1. checks Node, npm and reachable MySQL / MongoDB
      2. writes .env.local with a freshly generated JWT secret
      3. npm install
      4. builds the MySQL database (schema, routines, seed, DB accounts)
      5. creates the MongoDB collections and indexes
      6. builds the vector store

    What it does NOT do: install MySQL or MongoDB. Those are Windows
    installers and need your confirmation; the script tells you if they
    are missing and stops.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Die($msg)      { Write-Host "`nSTOPPED: $msg" -ForegroundColor Red; exit 1 }

Write-Host "PlotMatch setup" -ForegroundColor White
Write-Host "Folder: $root"

# ---------------------------------------------------------------------------
Step 1 "Checking prerequisites"

try { $nodeV = (node --version) } catch { Die "Node.js not found. Install the LTS build from https://nodejs.org and reopen PowerShell." }
$major = [int]($nodeV -replace '^v(\d+)\..*$', '$1')
if ($major -lt 18) { Die "Node $nodeV is too old. This project needs Node 18.17 or newer." }
Ok "Node $nodeV"

try { $npmV = (npm --version) } catch { Die "npm not found, though Node is installed. Reinstall Node from https://nodejs.org." }
Ok "npm $npmV"

# MySQL is reached through the mysql2 driver, so the mysql CLI is optional.
# What matters is that a server is listening.
function Test-Port($hostname, $port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $iar = $c.BeginConnect($hostname, $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(2000, $false)
        if ($ok) { $c.EndConnect($iar) }
        $c.Close()
        return $ok
    } catch { return $false }
}

if (Test-Port '127.0.0.1' 3306) { Ok "MySQL is listening on port 3306" }
else {
    Warn "Nothing is listening on port 3306."
    Warn "Install MySQL 8 Community Server: https://dev.mysql.com/downloads/installer/"
    Warn "During setup choose 'Developer Default' and remember the root password."
    Die  "MySQL must be running before this script can build the database."
}

$mongoRunning = Test-Port '127.0.0.1' 27017
if ($mongoRunning) { Ok "MongoDB is listening on port 27017" }
else { Warn "Nothing on port 27017 - you will be asked for an Atlas connection string instead." }

# ---------------------------------------------------------------------------
Step 2 "Writing .env.local"

if (Test-Path '.env.local') {
    $keep = Read-Host "    .env.local already exists. Keep it? [Y/n]"
    if ($keep -match '^[Nn]') { Remove-Item '.env.local' } else { Ok "Keeping existing .env.local" }
}

if (-not (Test-Path '.env.local')) {
    $sec = Read-Host "    MySQL root password (blank if none)" -AsSecureString
    $rootPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

    if ($mongoRunning) {
        $mongoUri = 'mongodb://localhost:27017/plotmatch'
    } else {
        $mongoUri = Read-Host "    MongoDB connection string (Atlas srv URI)"
        if (-not $mongoUri) { Die "A MongoDB connection string is required." }
    }

    # 48 cryptographically random bytes, base64url
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwt = [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_').TrimEnd('=')

    $env = @"
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=plotmatch_app
MYSQL_PASSWORD=app_Passw0rd!
MYSQL_DATABASE=plotmatch

MYSQL_ROOT_USER=root
MYSQL_ROOT_PASSWORD=$rootPw

MONGODB_URI=$mongoUri
MONGODB_DB=plotmatch
VECTOR_BACKEND=local

JWT_SECRET=$jwt
SESSION_COOKIE=plotmatch_session
SESSION_TTL_HOURS=12

EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
EMBEDDING_DIMENSIONS=384
"@

    # UTF-8 with NO byte-order mark. A BOM here makes dotenv read the first
    # key as "﻿MYSQL_HOST", which fails in a way that is hard to spot.
    [IO.File]::WriteAllText((Join-Path $root '.env.local'), $env,
                            (New-Object Text.UTF8Encoding $false))
    Ok ".env.local written with a fresh JWT secret"
}

# ---------------------------------------------------------------------------
Step 3 "Installing dependencies (a few minutes on first run)"
npm install
if ($LASTEXITCODE -ne 0) { Die "npm install failed - see the output above." }
Ok "Dependencies installed"

# ---------------------------------------------------------------------------
Step 4 "Building the MySQL database"
npm run db:setup -- --with-dcl
if ($LASTEXITCODE -ne 0) {
    Warn "If this says 'Access denied', the root password in .env.local is wrong."
    Warn "Delete .env.local and run this script again."
    Die  "Database build failed."
}
Ok "Schema, routines, seed data and database accounts created"

# ---------------------------------------------------------------------------
Step 5 "Creating MongoDB collections and indexes"
node scripts/setup-mongo.mjs
if ($LASTEXITCODE -ne 0) { Die "MongoDB setup failed - is the server running?" }
Ok "Collections and indexes created"

# ---------------------------------------------------------------------------
Step 6 "Building the vector store (first run downloads a ~90 MB model)"
npm run embed
if ($LASTEXITCODE -ne 0) { Die "Embedding failed - see the output above." }
Ok "Vector store populated"

# ---------------------------------------------------------------------------
Write-Host "`n======================================================" -ForegroundColor Green
Write-Host " Setup complete." -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
Write-Host @"

Start the app:    npm run dev
Then open:        http://localhost:3000

Sign in with:
    admin@plotmatch.dev / Admin@123     (admin)
    mod@plotmatch.dev   / Mod@12345     (moderator)
    sai@plotmatch.dev   / Sai@12345     (user)

Try the search box with a sentence rather than a title, for example
"a story about losing someone you love" - the semantic and keyword
panels appear side by side.

Seeded sessions:  MOVIE001 (ready to finalise)   BOOKCLUB (still open)
"@
