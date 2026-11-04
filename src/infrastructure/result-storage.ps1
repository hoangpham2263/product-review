# Result images go to the GitHub repo hoangpham2263/product-review-results through the product-review-api Worker
# (worker/ at the repo root), which holds the GitHub token: the app needs no password. PR_RESULTS_API points tests
# at a local stand-in.
$script:ResultsApiUrl = 'https://product-review-api.hoangpham2263.workers.dev'

function Get-ResultStore {
    $url = if ($env:PR_RESULTS_API) { $env:PR_RESULTS_API } else { $script:ResultsApiUrl }
    return @{ ApiUrl = $url.TrimEnd('/') }
}

function Assert-ResultStoreReady {
    $store=$script:Config.Results
    if(-not $store){throw '[CAUSE:RESULT_CONFIG] Chưa có kho kết quả để xuất link công khai.'}
    try{
        $status=Invoke-RestMethod -Uri "$($store.ApiUrl)/api/status" -TimeoutSec 30
        if(-not $status.ok){throw '[CAUSE:RESULT_CONFIG] Kho kết quả trên GitHub chưa sẵn sàng.'}
    }catch{
        if($_.Exception.Message -match '\[CAUSE:RESULT_CONFIG\]'){throw}
        throw '[CAUSE:RESULT_CONFIG] Chưa kiểm tra được kho kết quả. Kiểm tra kết nối mạng trước khi chạy.'
    }
}

# Upload one PNG and return its public link for the CSV.
function Publish-ResultImage([string]$Path, [string]$BatchId, [string]$Product) {
    $store = $script:Config.Results
    if(-not $store){throw '[CAUSE:RESULT_CONFIG] Chưa có kho kết quả.'}
    $query = 'batch={0}&name={1}&product={2}' -f [Uri]::EscapeDataString($BatchId), [Uri]::EscapeDataString([IO.Path]::GetFileName($Path)), [Uri]::EscapeDataString($Product)
    $bytes=[IO.File]::ReadAllBytes($Path)
    for($attempt=1;$attempt -le 3;$attempt++){
        $tag=if($script:ResultUploadIndex){"  (#$script:ResultUploadIndex)"}else{''}
        Write-Host "  [RESULT-UPLOAD] $attempt/3$tag" -ForegroundColor Cyan
        try{
            $result=Invoke-RestMethod -Uri "$($store.ApiUrl)/api/images?$query" -Method Post -ContentType 'image/png' -Body $bytes -TimeoutSec 120
            $uri=$null
            if(-not [Uri]::TryCreate([string]$result.url,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'https' -or -not $uri.Host){throw '[CAUSE:RESULT_UPLOAD] Máy chủ không trả link ảnh HTTPS công khai.'}
            return [string]$result.url
        }catch{
            $code=0
            if($_.Exception.Response){try{$code=[int]$_.Exception.Response.StatusCode}catch{}}
            if($_.Exception.Message -match '\[CAUSE:RESULT_UPLOAD\]'){throw}
            if($attempt -eq 3 -or ($code -ge 400 -and $code -lt 500 -and $code -notin @(408,409,429))){throw "[CAUSE:RESULT_UPLOAD] Tải ảnh lên kho kết quả chưa thành công (HTTP $code). Ảnh đã lưu; thử bàn giao lại để tiếp tục upload, không tạo ảnh mới."}
            Write-Host "  [RESULT-RETRY] $($attempt+1)/3 HTTP $code$tag" -ForegroundColor Cyan
            Start-Sleep -Seconds $attempt
        }
    }
}
