$port = 3000
$root = Split-Path $MyInvocation.MyCommand.Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css'
  '.js'   = 'application/javascript'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff2'= 'font/woff2'
  '.mjs'  = 'application/javascript'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Running at http://localhost:$port"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  $urlPath = [System.Uri]::UnescapeDataString($req.Url.LocalPath)
  if ($urlPath -eq '/') { $urlPath = '/index.html' }
  $filePath = Join-Path $root ($urlPath.TrimStart('/').Replace('/', '\'))
  if (-not [System.IO.Path]::GetExtension($filePath) -and -not (Test-Path $filePath -PathType Leaf)) {
    $filePath += '.html'
  }

  if (Test-Path $filePath -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
    $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $res.ContentType = $ct
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
    $body = [System.Text.Encoding]::UTF8.GetBytes('Not found')
    $res.OutputStream.Write($body, 0, $body.Length)
  }
  $res.OutputStream.Close()
}
