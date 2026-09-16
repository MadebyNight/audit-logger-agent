$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$src = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$out = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$pages = @(
  '01-home.html|home.png|1180,700',
  '02-agent.html|agent-page.png|1180,900',
  '03-task-list.html|task-list.png|1180,720',
  '04-task-detail.html|task-detail.png|1180,1000'
)

foreach ($line in $pages) {
  $parts = $line.Split('|')
  $file = $parts[0]
  $png = $parts[1]
  $size = $parts[2]
  $target = Join-Path $out $png
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  $rel = ($src + '\' + $file).Replace('\', '/')
  $uri = 'file:///' + $rel
  & $chrome '--headless' '--disable-gpu' '--hide-scrollbars' '--force-device-scale-factor=2' "--window-size=$size" "--screenshot=$target" $uri | Out-Null
}

Get-ChildItem -LiteralPath $out | Select-Object Name, Length | Format-Table -AutoSize | Out-String
