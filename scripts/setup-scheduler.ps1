# Script to register the Wintron Weekly Scraper in Windows Task Scheduler
# Schedule: Weekly every Monday at 11:00 AM

$TaskName = "WintronWeeklyScraper"
$BatchPath = "E:\yash_wintronelectronics\scripts\run-weekly-scrape.bat"

Write-Host "Configuring Windows Scheduled Task: $TaskName"
Write-Host "Target Batch File: $BatchPath"
Write-Host "Schedule: Every Monday at 11:00 AM"

# Define Action
$Action = New-ScheduledTaskAction -Execute $BatchPath -WorkingDirectory "E:\yash_wintronelectronics"

# Define Trigger (Every Monday at 11:00 AM)
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 11:00am

# Define Settings
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Register or update task
try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Runs Wintron Electronics scraper weekly on Mondays at 11:00 AM and emails report"
    Write-Host "SUCCESS: Task '$TaskName' has been registered successfully."
} catch {
    Write-Error "Failed to register scheduled task: $_"
}
