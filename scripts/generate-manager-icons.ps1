[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Drawing
    $root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $icons = Join-Path $root 'apps\codex-plus-manager\src-tauri\icons'
    $source = [System.Drawing.Bitmap]::new((Join-Path $icons 'icon.png'))
    $canvas = [System.Drawing.Bitmap]::new(512, 512)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $green = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#087F5B'))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $gear = [System.Drawing.Drawing2D.GraphicsPath]::new()
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, 512, 512)
        # 白色描边隔开原图与管理角标，缩小到托盘尺寸后仍保留轮廓。
        $graphics.FillEllipse($white, 298, 298, 212, 212)
        $graphics.FillEllipse($green, 310, 310, 188, 188)
        $points = [System.Collections.Generic.List[System.Drawing.PointF]]::new()
        for ($tooth = 0; $tooth -lt 8; $tooth++) {
            foreach ($segment in @(@(0, 53), @(0.18, 67), @(0.62, 67), @(0.80, 53))) {
                $angle = ($tooth + $segment[0]) * [Math]::PI / 4
                $radius = $segment[1]
                $points.Add([System.Drawing.PointF]::new(
                    [single](404 + [Math]::Cos($angle) * $radius),
                    [single](404 + [Math]::Sin($angle) * $radius)))
            }
        }
        $gear.AddPolygon($points.ToArray())
        $graphics.FillPath($white, $gear)
        $graphics.FillEllipse($green, 379, 379, 50, 50)
        $canvas.Save((Join-Path $icons 'manager-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

        # ICO 包含常见 DPI 尺寸，避免任务栏和托盘只缩放单张大图。
        $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
        $frames = [System.Collections.Generic.List[byte[]]]::new()
        foreach ($size in $sizes) {
            $frame = [System.Drawing.Bitmap]::new($size, $size)
            $drawing = [System.Drawing.Graphics]::FromImage($frame)
            $stream = [System.IO.MemoryStream]::new()
            try {
                $drawing.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $drawing.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $drawing.DrawImage($canvas, 0, 0, $size, $size)
                $frame.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $frames.Add($stream.ToArray())
            } finally {
                $stream.Dispose()
                $drawing.Dispose()
                $frame.Dispose()
            }
        }
        $output = [System.IO.MemoryStream]::new()
        $writer = [System.IO.BinaryWriter]::new($output)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$sizes.Count)
            $offset = 6 + 16 * $sizes.Count
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
                $writer.Write([byte]$dimension)
                $writer.Write([byte]$dimension)
                $writer.Write([uint16]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$frames[$i].Length)
                $writer.Write([uint32]$offset)
                $offset += $frames[$i].Length
            }
            foreach ($frameBytes in $frames) {
                $writer.Write($frameBytes)
            }
            [System.IO.File]::WriteAllBytes((Join-Path $icons 'manager-icon.ico'), $output.ToArray())
        } finally {
            $writer.Dispose()
            $output.Dispose()
        }
        [pscustomobject]@{ Width = $canvas.Width; Height = $canvas.Height; IconSizes = $sizes } |
            ConvertTo-Json -Compress
    } finally {
        $gear.Dispose()
        $white.Dispose()
        $green.Dispose()
        $graphics.Dispose()
        $canvas.Dispose()
        $source.Dispose()
    }
} catch {
    Write-Error $_
    exit 1
}
