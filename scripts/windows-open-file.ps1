param(
    [switch]$Install,
    [string]$Document
)
$ErrorActionPreference = 'Stop'

if ($Install) {
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '" -Document $(Arg0)'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances Queue -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'CASM Open Document' -Principal $principal -Action $action -Settings $settings -Force | Out-Null
    return
}

$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Document))
if ($path -notmatch '^[a-z]:\\[^:]+$') { throw 'Expected a local drive path.' }
$file = Get-Item -LiteralPath $path
$extensions = '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.xml',
    '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.html', '.htm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff',
    '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.webm', '.mov'
if ($file -isnot [IO.FileInfo] -or $file.FullName -notmatch '^[a-z]:\\[^:]+$' -or
        $file.LinkType -or $file.Extension -notin $extensions) {
    throw 'Expected a supported local document.'
}
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $file.FullName
$start.UseShellExecute = $true
[void][System.Diagnostics.Process]::Start($start)
