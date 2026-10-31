Add-Type -AssemblyName System.Drawing

$srcPath = "assets/images/app icon.png"
if (-not (Test-Path $srcPath)) {
    Write-Error "Source icon not found at $srcPath"
    exit 1
}

$srcImage = [System.Drawing.Image]::FromFile($srcPath)

function Resize-Image {
    param(
        [System.Drawing.Image]$Image,
        [int]$Width,
        [int]$Height,
        [string]$DestinationPath,
        [bool]$CircleClip = $false
    )

    $destDir = [System.IO.Path]::GetDirectoryName($DestinationPath)
    if (-not (Test-Path $destDir)) {
        [System.IO.Directory]::CreateDirectory($destDir) | Out-Null
    }

    $destBmp = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($destBmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $g.Clear([System.Drawing.Color]::Transparent)

    if ($CircleClip) {
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddEllipse(0, 0, $Width, $Height)
        $g.SetClip($path)
    }

    $g.DrawImage($Image, 0, 0, $Width, $Height)

    $g.Dispose()

    # Save PNG
    $destBmp.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $destBmp.Dispose()
    Write-Host "Created: $DestinationPath ($Width x $Height)"
}

# 1. Public web icons
Resize-Image $srcImage 512 512 "public/app-icon.png"
Resize-Image $srcImage 192 192 "public/icon-192.png"
Resize-Image $srcImage 512 512 "public/icon-512.png"
Resize-Image $srcImage 64 64 "public/favicon.png"
Resize-Image $srcImage 32 32 "public/favicon.ico"

# Also copy full-size to public/app-icon-full.png
Copy-Item $srcPath "public/app-icon-full.png" -Force

# 2. Android Mipmaps
$densities = @(
    @{ Name = "mdpi"; Launcher = 48; Foreground = 108 },
    @{ Name = "hdpi"; Launcher = 72; Foreground = 162 },
    @{ Name = "xhdpi"; Launcher = 96; Foreground = 216 },
    @{ Name = "xxhdpi"; Launcher = 144; Foreground = 324 },
    @{ Name = "xxxhdpi"; Launcher = 192; Foreground = 432 }
)

foreach ($d in $densities) {
    $dir = "android/app/src/main/res/mipmap-$($d.Name)"
    Resize-Image $srcImage $d.Launcher $d.Launcher "$dir/ic_launcher.png"
    Resize-Image $srcImage $d.Launcher $d.Launcher "$dir/ic_launcher_round.png" -CircleClip $true
    Resize-Image $srcImage $d.Foreground $d.Foreground "$dir/ic_launcher_foreground.png"
}

$srcImage.Dispose()
Write-Host "All icons generated successfully!"
