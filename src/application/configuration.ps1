function New-WorkflowConfiguration([string]$ProjectRoot, [string]$SourceDir, [string]$Model) {
    $workspace = Initialize-ProjectWorkspace $ProjectRoot
    $contexts = @(Get-ProductContexts (Join-Path $ProjectRoot 'data/product-contexts.json'))
    # SourceCatalog is read only by the reference archive, which builds it itself (cached per process): not here, it cost ~9 s on every agent.ps1 call
    $catalog = $null
    return @{
        SourceDir = $SourceDir; Model = $Model
        ReviewSamples = @(Get-ReviewSamples (Join-Path $ProjectRoot 'data/review-samples.jsonl'))
        ProductContexts = $contexts
        SourceCatalog = $catalog
        AgentInstructionsPath = Join-Path $ProjectRoot 'AGENTS.md'
        FeedbackRoot = Join-Path $workspace.Root 'feedback'
        Results = Get-ResultStore
        DeliveryRoot = Join-Path $workspace.Root 'delivery-pending'
        WritingStyle = Get-WritingStyle (Join-Path $ProjectRoot 'data/writing-style.json')
    }
}
