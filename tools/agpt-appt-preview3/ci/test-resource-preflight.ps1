# Requires Windows PowerShell 5.1 or PowerShell 7. No build or AutoCAD execution.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixtureRoot = $null
$passed = 0
$failed = 0

try {
    $sourceRoot = Split-Path -Parent $PSScriptRoot
    $buildPath = Join-Path $sourceRoot 'build.ps1'
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($buildPath, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -ne 0) {
        throw ('build.ps1 parse failed: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; '))
    }
    $functions = @($ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Assert-SourceResources'
    }, $true))
    if ($functions.Count -ne 1) { throw 'Expected exactly one Assert-SourceResources function.' }
    # Load only this function definition. Never dot-source or execute build.ps1.
    . ([scriptblock]::Create($functions[0].Extent.Text))
    $fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('AGPT-preflight-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null

    function Test-Case([string]$Name, [bool]$ShouldPass, [scriptblock]$Arrange) {
        $caseRoot = Join-Path $fixtureRoot $Name
        [IO.Directory]::CreateDirectory($caseRoot) | Out-Null
        $blocks = Join-Path $caseRoot 'blocks'
        & $Arrange $blocks
        # The extracted function resolves $root from this invocation scope.
        $root = $caseRoot
        $accepted = $true
        try { Assert-SourceResources }
        catch { $accepted = $false }
        if ($accepted -eq $ShouldPass) {
            $script:passed++
            Write-Host ('PASS: ' + $Name)
        } else {
            $script:failed++
            Write-Host ('FAIL: ' + $Name + ' expected accepted=' + $ShouldPass + ', actual=' + $accepted)
        }
    }

    Test-Case 'missing-blocks' $false { param($blocks) }
    Test-Case 'readme-only' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllText((Join-Path $blocks 'README_SOURCE_ONLY.md'), 'Restore original resources.')
    }
    Test-Case 'frame-only' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_Frame_A3.dwg'), [byte[]]@(1))
    }
    Test-Case 'empty-ugo' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_Frame_A3.dwg'), [byte[]]@(1))
        [IO.File]::WriteAllBytes((Join-Path $blocks 'Садик_UGO_source.dwg'), [byte[]]@())
    }
    Test-Case 'empty-preferred-frame-with-fallback' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $blocks 'ММХ_Штамп.dwg'), [byte[]]@())
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_Frame_A3.dwg'), [byte[]]@(1))
        [IO.File]::WriteAllBytes((Join-Path $blocks 'Садик_UGO_source.dwg'), [byte[]]@(2))
    }
    Test-Case 'empty-preferred-ugo-with-fallback' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_Frame_A3.dwg'), [byte[]]@(1))
        [IO.File]::WriteAllBytes((Join-Path $blocks 'Садик_UGO_source.dwg'), [byte[]]@())
        [IO.File]::WriteAllBytes((Join-Path $blocks 'Садик.dwg'), [byte[]]@(2))
    }
    Test-Case 'unused-aliases-only' $false { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        [IO.File]::WriteAllText((Join-Path $blocks 'README_SOURCE_ONLY.md'), 'Restore original resources.')
        [IO.File]::WriteAllBytes((Join-Path $blocks 'MMX_ШТАМП.dwg'), [byte[]]@(1))
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_UGO.dxf'), [byte[]]@(2))
    }
    Test-Case 'nonempty-known-filenames' $true { param($blocks)
        [IO.Directory]::CreateDirectory($blocks) | Out-Null
        # Synthetic bytes test presence only; these are NOT valid CAD resources.
        [IO.File]::WriteAllBytes((Join-Path $blocks 'AGPT_Frame_A3.dwg'), [byte[]]@(1))
        [IO.File]::WriteAllBytes((Join-Path $blocks 'Садик_UGO_source.dwg'), [byte[]]@(2))
    }
    Write-Host ('Passed: ' + $passed + ', Failed: ' + $failed)
    Write-Host 'Presence checks only; CAD format/content validity and host loading are not verified.'
    if ($failed -ne 0) { exit 1 }
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
