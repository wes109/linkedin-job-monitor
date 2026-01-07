# LinkedIn Job Monitor

Automatically tracks new LinkedIn job postings and sends notifications to Discord via webhook.

## Features

- 🔍 Monitors LinkedIn job listings based on customizable search criteria
- 🔔 Sends real-time notifications to Discord when new jobs are found
- 🎯 Filters by keywords, location, workplace type (Remote/Hybrid/On-site), and job function
- ⏰ Configurable refresh interval
- 📊 Includes job details: company, location, salary, job type, applicants, posting time
- 🖼️ Displays company logos in Discord embeds
- ✅ Marks "Easy Apply" jobs in notifications
- 💾 Tracks sent jobs to avoid duplicates

## Prerequisites

- Node.js (v14 or higher)
- A Discord webhook URL
- A LinkedIn account (for authentication)

## Installation

1. Clone this repository:
```bash
git clone https://github.com/wes109/linkedin-job-monitor.git
cd linkedin-job-monitor
```

2. Install dependencies:
```bash
npm install
```

3. Install Playwright browsers:
```bash
npx playwright install chromium
```

4. Create a `.env` file in the root directory and configure your settings:
```env
SEARCH_KEYWORDS=your search keywords here
SEARCH_LOCATION=your location here
SEARCH_POSTED_MINUTES=1440
SEARCH_WORKPLACE_TYPE=Remote
SEARCH_JOB_FUNCTIONS=it,eng,qa
DISCORD_WEBHOOK_URL=your_discord_webhook_url
REFRESH_INTERVAL_SECONDS=10
CHROME_USER_DATA_DIR=chrome-profile
```

### Environment Variables

- `SEARCH_KEYWORDS` (required): Job search keywords (e.g., "quality assurance OR QA Engineer")
- `SEARCH_LOCATION` (required): Location for job search (e.g., "United States")
- `SEARCH_POSTED_MINUTES` (optional): Only show jobs posted within this many minutes (default: 1440 = 24 hours)
- `SEARCH_WORKPLACE_TYPE` (optional): Filter by workplace type. Options: `Remote`, `Hybrid`, `Onsite`, `RemoteOrHybrid` (or leave blank for any)
- `SEARCH_JOB_FUNCTIONS` (optional): Comma-separated job function codes (e.g., `it,eng,qa,prjm`). Common codes:
  - `it` - Information Technology
  - `eng` - Engineering
  - `prjm` - Project Management
  - `prdm` - Product Management
  - `qa` - Quality Assurance
  - `cnsl` - Consulting
  - `mgmt` - Management
- `DISCORD_WEBHOOK_URL` (required): Your Discord webhook URL
- `REFRESH_INTERVAL_SECONDS` (optional): How often to check for new jobs in seconds (default: 10)
- `CHROME_USER_DATA_DIR` (optional): Path to Chrome user profile directory for persistent login (default: temporary profile)

## Usage

1. Run the script:
```bash
npm start
```

2. If you haven't configured a persistent Chrome profile, the browser will open and you'll need to log in to LinkedIn manually. Press Enter in the terminal after logging in.

3. The script will:
   - Perform an initial check and send any new jobs found
   - Continue monitoring at the specified interval
   - Send notifications to Discord for each new job as it's discovered

## How It Works

1. The script opens a browser (Chrome) and navigates to your configured LinkedIn job search
2. It checks the first N job listings (configurable, default: 5)
3. For each job, it:
   - Checks if the job has already been sent
   - If new, clicks the job card to load details
   - Extracts job information (title, company, location, salary, etc.)
   - Sends a formatted embed to Discord
   - Marks the job as sent to avoid duplicates

## Notes

- The script uses Playwright to automate the browser
- Jobs are tracked in `sent_jobs.txt` (excluded from git)
- The script clears the sent jobs file on each startup
- Use a persistent Chrome profile (`CHROME_USER_DATA_DIR`) to avoid logging in each time

## License

ISC
