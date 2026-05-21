# Serve Arctium Labs locally (required for route/emissions GeoJSON).
$Port = 8080
$Root = $PSScriptRoot
Set-Location $Root

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}

if (-not $python) {
  Write-Host "Python not found. Install Python 3, then run:" -ForegroundColor Red
  Write-Host "  python -m http.server $Port" -ForegroundColor Yellow
  exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host "Serving $Root" -ForegroundColor Cyan
Write-Host "Open: $url" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray

Start-Process $url
& $python.Source -m http.server $Port
