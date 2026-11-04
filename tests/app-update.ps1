. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $root 'core/update.ps1') -NoRun
$root=Split-Path $PSScriptRoot -Parent  # update.ps1's -Root param shares the name
. (Join-Path $root 'src/application/agent-lessons.ps1')
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
$temp=Join-Path $TestWorkspaceRoot ('app-update-'+[Guid]::NewGuid().ToString('N'))
try{
    $new=Join-Path $temp 'new';$app=Join-Path $temp 'app'
    # Copy-AppUpdate replaces the app's files and keeps AGENTS.md, workspace/ and the bridge's installed packages.
    $rel=Join-Path $temp 'release';$inst=Join-Path $temp 'install'
    foreach($p in @("$rel/src/gui.ps1","$rel/AGENTS.md","$rel/workspace/config/ai-model.json","$rel/workspace/version.txt","$rel/core/update.ps1","$rel/core/bridge/node_modules/ws/index.js","$inst/src/gui.ps1","$inst/AGENTS.md","$inst/workspace/config/ai-model.json","$inst/workspace/version.txt","$inst/core/bridge/node_modules/ws/index.js")){New-Item -ItemType File -Force -Path $p|Out-Null}
    Set-Content "$rel/src/gui.ps1" 'new';Set-Content "$rel/src/added.ps1" 'added' -Force;Set-Content "$rel/core/update.ps1" 'core' -Force
    Set-Content "$rel/AGENTS.md" 'upstream';Set-Content "$rel/workspace/config/ai-model.json" 'upstream';Set-Content "$rel/workspace/version.txt" 'upstream';Set-Content "$rel/core/bridge/node_modules/ws/index.js" 'upstream'
    Set-Content "$inst/AGENTS.md" 'my lessons';Set-Content "$inst/workspace/config/ai-model.json" 'my model';Set-Content "$inst/workspace/version.txt" 'v1';Set-Content "$inst/core/bridge/node_modules/ws/index.js" 'installed'
    Copy-AppUpdate $rel $inst
    Assert ((Get-Content "$inst/src/gui.ps1") -eq 'new' -and (Test-Path "$inst/src/added.ps1") -and (Get-Content "$inst/core/update.ps1") -eq 'core') 'App files must be updated and new files added.'
    Assert ((Get-Content "$inst/AGENTS.md") -eq 'my lessons' -and (Get-Content "$inst/workspace/config/ai-model.json") -eq 'my model' -and (Get-Content "$inst/workspace/version.txt") -eq 'v1' -and (Get-Content "$inst/core/bridge/node_modules/ws/index.js") -eq 'installed') 'Lessons, workspace and installed packages must be kept.'
    foreach($p in @("$new/AGENTS.md","$app/AGENTS.md","$app/workspace/x")){New-Item -ItemType File -Force -Path $p|Out-Null}
    # AGENTS.md: the guide follows the release; this machine's lessons stay and the release's new ones are added once.
    $lesson={param($Id,$Text)"### $Id`n<!-- app-lesson: {`"id`":`"$Id`",`"scope`":`"category`",`"category`":`"x`"} -->`n- $Text`n`n"}
    $block={param($Items)"<!-- app-lessons:start -->`n## Bài học`n`nGhi chú.`n`n$($Items -join '')<!-- app-lessons:end -->`n"}
    Set-Content "$new/AGENTS.md" ("# Hướng dẫn mới`n`n"+(& $block @((& $lesson 'shared-a' 'chung a'),(& $lesson 'shared-b' 'chung b')))) -Encoding UTF8 -NoNewline
    Set-Content "$app/AGENTS.md" ("# Hướng dẫn cũ`n`n"+(& $block @((& $lesson 'shared-a' 'chung a, máy này sửa'),(& $lesson 'mine' 'riêng máy')))) -Encoding UTF8 -NoNewline
    Remove-Item "$app/workspace/agent-lessons-seen.txt" -ErrorAction SilentlyContinue
    Merge-AgentInstructions $new $app
    $merged=Get-Content "$app/AGENTS.md" -Raw
    Assert ($merged.Contains('# Hướng dẫn mới') -and -not $merged.Contains('# Hướng dẫn cũ')) 'The guide must follow the release.'
    Assert ($merged.Contains('chung a, máy này sửa') -and $merged -notmatch '(?m)^- chung a\r?$') "This machine's version of a lesson must be kept."
    Assert ($merged.Contains('riêng máy') -and $merged.Contains('chung b')) 'Own lessons stay and new release lessons are added.'
    Assert ((Read-AgentLessons "$app/AGENTS.md").Count -eq 3) 'The merged lessons must still read as valid lessons.'
    Assert (Test-Path "$app/workspace/backups/AGENTS-before-update.md") 'The previous AGENTS.md must be backed up.'
    # A release lesson removed on this machine is not brought back by the next update.
    Set-Content "$app/AGENTS.md" ("# Hướng dẫn mới`n`n"+(& $block @((& $lesson 'mine' 'riêng máy')))) -Encoding UTF8 -NoNewline
    Merge-AgentInstructions $new $app
    $again=Get-Content "$app/AGENTS.md" -Raw
    Assert (-not $again.Contains('shared-b') -and -not $again.Contains('shared-a')) 'Removed release lessons must stay removed.'
    # A lesson still as last shipped takes the release's new wording; one edited here keeps this machine's text.
    Set-Content "$app/AGENTS.md" ("# Hướng dẫn mới`n`n"+(& $block @((& $lesson 'shared-a' 'chung a'),(& $lesson 'shared-b' 'chung b, máy này sửa')))) -Encoding UTF8 -NoNewline
    Set-Content "$new/AGENTS.md" ("# Hướng dẫn mới`n`n"+(& $block @((& $lesson 'shared-a' 'chung a, bản mới'),(& $lesson 'shared-b' 'chung b, bản mới')))) -Encoding UTF8 -NoNewline
    Merge-AgentInstructions $new $app
    $refined=Get-Content "$app/AGENTS.md" -Raw
    Assert ($refined.Contains('chung a, bản mới') -and $refined.Contains('chung b, máy này sửa') -and -not $refined.Contains('chung b, bản mới')) 'Unchanged lessons take new wording; edited ones stay.'
    # A file without a readable lessons block is left as it is.
    Set-Content "$app/AGENTS.md" 'my lessons'
    Merge-AgentInstructions $new $app
    Assert ((Get-Content "$app/AGENTS.md") -eq 'my lessons') 'An unreadable AGENTS.md must be left untouched.'
    # The check names the new version for ZIP installs and git checkouts alike.
    Assert ($script:Repo -eq 'hoangpham2263/product-review' -and $script:Asset -eq 'product-review.zip') 'Updates must come from the product-review releases.'
    function Get-LatestRelease { [pscustomobject]@{ tag_name = 'v1.0.15' } }
    Set-Content "$app/workspace/version.txt" 'v1.0.14'
    Assert ((Get-AppUpdate $app) -eq 'v1.0.15') 'A ZIP install must be offered the newer version by name.'
    Set-Content "$app/workspace/version.txt" 'v1.0.15'
    Assert (-not (Get-AppUpdate $app)) 'The newest version must not be offered again.'
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $repo=Join-Path $temp 'checkout';New-Item -ItemType Directory -Force -Path $repo|Out-Null
        git -C $repo init --quiet;git -C $repo -c user.name=t -c user.email=t@t commit --quiet --allow-empty -m init;git -C $repo tag v1.0.14
        Assert ((Get-AppUpdate $repo) -eq 'v1.0.15') 'A git checkout must be offered the newer version by name, not just told there is one.'
    }
    # Opening the app never updates it: only the Cập nhật dialog's button installs (it posts /api/update to the app's
    # server). Launchers and background checks only run -Check.
    $installers=@(Get-ChildItem -LiteralPath (Join-Path $root 'src'),(Join-Path $root 'core') -Recurse -File -Include *.ps1,*.mjs,*.js,*.cmd,*.command|Where-Object{$_.Name -ne 'update.ps1' -and (Get-Content -LiteralPath $_.FullName -Raw) -match "Update-App|'-Apply'|/api/update"}|ForEach-Object Name|Sort-Object -Unique)
    foreach($launcher in @('start-app.cmd','start-app.command')){Assert ((Get-Content -LiteralPath (Join-Path $root $launcher) -Raw) -notmatch 'update') "$launcher must not update the app."}
    Assert (($installers -join ',') -eq 'app.js,server.mjs') "Only the Cập nhật dialog may install an update, found in: $($installers -join ', ')"
    $js=Get-Content -LiteralPath (Join-Path $root 'src/mac/ui/app.js') -Raw;$button=$js.IndexOf('go.onclick = async');$install=$js.IndexOf('fetch("/api/update"')
    Assert ([regex]::Matches($js,'/api/update').Count -eq 1 -and $button -ge 0 -and $install -gt $button -and $install - $button -lt 400) 'macOS installs only from the dialog button.'
}finally{Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue}
Write-Host 'PASS: updates come from the product-review releases, replace app files and keep workspace and local lessons while adding new shared ones; the check names the new version.'
