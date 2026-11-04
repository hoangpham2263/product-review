. (Join-Path $PSScriptRoot 'helpers.ps1')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
. (Join-Path $project 'src/bootstrap.ps1')
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
$temp=Join-Path $TestWorkspaceRoot ('result-storage-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp|Out-Null
try{
    Assert ((Get-ResultStore).ApiUrl -eq 'https://product-review-api.hoangpham2263.workers.dev') 'The app must send results to the product-review-api Worker.'
    $env:PR_RESULTS_API='https://api.test/'
    $store=Get-ResultStore
    Remove-Item Env:\PR_RESULTS_API
    Assert ($store.ApiUrl -eq 'https://api.test') 'PR_RESULTS_API must point the app elsewhere.'

    $script:Config=@{Results=$store}
    $image=Join-Path $temp '001-tee.png'
    [IO.File]::WriteAllBytes($image,[byte[]](137,80,78,71))
    function Invoke-RestMethod($Uri,$Method,$ContentType,$Headers,$Body,$TimeoutSec){
        Assert ($Uri -eq 'https://api.test/api/images?batch=b%201&name=001-tee.png&product=tee' -and $Method -eq 'Post') "Unexpected upload request: $Uri"
        Assert (-not $Headers -and $Body.Length -eq 4) 'The upload sends the image bytes and no password.'
        [pscustomobject]@{url='https://raw.githubusercontent.com/o/r/main/b-1/tee/001-tee.png'}
    }
    Assert ((Publish-ResultImage $image 'b 1' 'tee') -eq 'https://raw.githubusercontent.com/o/r/main/b-1/tee/001-tee.png') 'The public link was not returned.'
    $script:UploadCalls=0
    function Start-Sleep($Seconds,$Milliseconds) {}
    function Invoke-RestMethod {
        $script:UploadCalls++
        if($script:UploadCalls -lt 3){throw [TimeoutException]::new('Temporary upload timeout')}
        return [pscustomobject]@{url='https://api.test/img/retried.png'}
    }
    Assert ((Publish-ResultImage $image 'b 1' 'tee') -eq 'https://api.test/img/retried.png' -and $script:UploadCalls -eq 3) 'Transient upload retries failed.'
    function Invoke-RestMethod {return [pscustomobject]@{url='C:/local/image.png'}}
    $blocked=$false;try{Publish-ResultImage $image 'b 1' 'tee'|Out-Null}catch{$blocked=$_.Exception.Message -match 'RESULT_UPLOAD'}
    Assert $blocked 'Server local paths were accepted as public links.'
    function Invoke-RestMethod {return [pscustomobject]@{ok=$false}}
    $blocked=$false;try{Assert-ResultStoreReady}catch{$blocked=$_.Exception.Message -match 'RESULT_CONFIG'}
    Assert $blocked 'A Worker without its GitHub token passed startup checks.'
    function Invoke-RestMethod {return [pscustomobject]@{ok=$true}}
    Assert-ResultStoreReady
    # In an install the settings live in workspace/config; outside one, in the workspace asked for.
    $install=Join-Path $temp 'install';New-Item -ItemType Directory -Force (Join-Path $install 'core'),(Join-Path $install 'workspace')|Out-Null
    Set-Content (Join-Path $install 'core/update.ps1') ''
    Assert ((Get-SharedConfigPath (Join-Path $install 'workspace') 'ai-model.json') -eq (Join-Path $install 'workspace/config/ai-model.json')) 'Settings of an install belong in workspace/config.'
    Assert ((Get-SharedConfigPath $temp 'ai-model.json') -eq (Join-Path $temp 'ai-model.json')) 'Outside an install a setting stays where it is asked for.'
    Write-Host 'PASS: results go to the Worker without a password, return the public link and retry transient errors.'
}finally{Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue}
