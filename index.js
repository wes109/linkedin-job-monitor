// LinkedIn Job Watcher

require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs').promises; // Use promises version of fs
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
// Check for headless flag (supports -headless, --headless, or any variation)
const isHeadless = args.some(arg => 
    arg === '-headless' || 
    arg === '--headless' || 
    arg.toLowerCase() === 'headless' ||
    arg.startsWith('--headless') ||
    arg.startsWith('-headless')
);

// -- Constants --
const CARDS_TO_CHECK = 5; // Number of most recent cards to check
const SENT_JOBS_FILE = path.join(__dirname, 'sent_jobs.txt');

// -- Configuration Loading --
const searchKeywords = process.env.SEARCH_KEYWORDS;
const searchLocation = process.env.SEARCH_LOCATION;
const searchPostedMinutes = parseInt(process.env.SEARCH_POSTED_MINUTES, 10) || 1440; // Default 24 hours
const searchWorkplaceType = process.env.SEARCH_WORKPLACE_TYPE;
const searchJobFunctions = process.env.SEARCH_JOB_FUNCTIONS; // Job function codes (e.g., "it,eng,qa")
const searchIndustries = process.env.SEARCH_INDUSTRIES; // Industry/sector codes (e.g., "96,6" for IT Services and Technology)
const filterKeywords = process.env.FILTER_KEYWORDS; // Optional: Comma-separated keywords to filter jobs by title (e.g., "qa,quality,automation,test")
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const refreshIntervalSeconds = parseInt(process.env.REFRESH_INTERVAL_SECONDS, 10) || 10; // Default 10 seconds
const chromeUserDataDir = process.env.CHROME_USER_DATA_DIR; // Optional

// -- Configuration Validation --
if (!searchKeywords || !searchLocation || !discordWebhookUrl) {
    console.error('Error: SEARCH_KEYWORDS, SEARCH_LOCATION, and DISCORD_WEBHOOK_URL must be set in the .env file.');
    process.exit(1);
}
if (discordWebhookUrl === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.warn('Warning: Please replace the placeholder value for DISCORD_WEBHOOK_URL in the .env file.');
    // Consider exiting if webhook isn't set up
}

// --- State --- 
let sentJobIdsThisRun = new Set(); // In-memory set for quick checks

// -- Helper Functions --

/**
 * Builds the LinkedIn job search URL from configuration.
 */
function buildLinkedInSearchUrl() {
    const baseUrl = 'https://www.linkedin.com/jobs/search/';
    const params = new URLSearchParams();

    if (searchKeywords) params.set('keywords', searchKeywords);
    if (searchLocation) params.set('location', searchLocation);
    if (searchPostedMinutes > 0) {
        const seconds = searchPostedMinutes * 60;
        params.set('f_TPR', `r${seconds}`); 
    }
    
    // Add Workplace Type Filter (f_WT)
    let workplaceParam = '';
    switch (searchWorkplaceType?.toLowerCase()) {
        case 'remote': workplaceParam = '2'; break;
        case 'hybrid': workplaceParam = '3'; break;
        case 'remoteorhybrid': workplaceParam = '2,3'; break;
        case 'onsite': workplaceParam = '1'; break;
    }
    if (workplaceParam) {
        params.set('f_WT', workplaceParam);
    }

    // Add Job Function Filter (f_F)
    if (searchJobFunctions && searchJobFunctions.trim()) {
        console.log(`Applying Job Function filter: ${searchJobFunctions}`);
        params.set('f_F', searchJobFunctions.trim()); // Pass the comma-separated string directly
    }

    // Add Industry/Sector Filter (f_I)
    if (searchIndustries && searchIndustries.trim()) {
        console.log(`Applying Industry filter: ${searchIndustries}`);
        params.set('f_I', searchIndustries.trim()); // Pass the comma-separated string directly
    }

    params.set('sortBy', 'DD'); // Sort by date descending (most recent)
    return `${baseUrl}?${params.toString()}`;
}

/**
 * Safely extracts text content from a locator, returning 'N/A' on error or timeout.
 * @param {import('playwright').Locator} locator 
 * @param {number} timeout 
 * @returns {Promise<string>}
 */
async function safeGetText(locator, timeout = 3000) {
    try {
        await locator.waitFor({ state: 'visible', timeout });
        const text = await locator.textContent();
        return text ? text.trim() : 'N/A'; // Basic trim
    } catch (error) {
        // console.warn(`safeGetText failed: ${error.message}`); 
        return 'N/A';
    }
}

/**
 * Safely extracts an attribute from a locator, returning null on error or timeout.
 * @param {import('playwright').Locator} locator 
 * @param {string} attributeName 
 * @param {number} timeout 
 * @returns {Promise<string|null>}
 */
async function safeGetAttribute(locator, attributeName, timeout = 3000) {
    try {
        await locator.waitFor({ state: 'visible', timeout });
        const attributeValue = await locator.getAttribute(attributeName);
        return attributeValue; // Return null if attribute doesn't exist
    } catch (error) {
        // console.warn(`safeGetAttribute failed for ${attributeName}: ${error.message}`);
        return null;
    }
}

/**
 * Checks if a job title matches the filter keywords (if configured).
 * @param {string} title - Job title to check
 * @returns {boolean} - True if job should be included (matches keywords or no filter configured)
 */
function matchesFilterKeywords(title) {
    if (!filterKeywords || !filterKeywords.trim()) {
        return true; // No filter configured, include all jobs
    }
    
    const keywords = filterKeywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0);
    if (keywords.length === 0) {
        return true; // Empty filter, include all jobs
    }
    
    const titleLower = (title || '').toLowerCase();
    const matches = keywords.some(keyword => titleLower.includes(keyword));
    
    return matches;
}

/**
 * Sends job details (including extra details) to Discord webhook.
 * @param {object} job 
 */
async function sendToDiscord(job) {
    console.log(`Attempting to send job ID ${job.id} to Discord...`);
    try {
        // --- Prepare Title --- 
        let finalTitle = job.title || 'N/A';
        if (job.isEasyApply) {
            finalTitle += ' (Easy Apply)';
        }

        // --- Prepare Fields --- 
        const fields = [
            { name: 'Company', value: job.company || 'N/A', inline: true },
            { name: 'Location', value: job.location || 'N/A', inline: true },
        ];
        
        // Add workplace type only if it was found
        if (job.workplaceType && job.workplaceType !== 'N/A') {
            fields.push({ name: 'Workplace', value: job.workplaceType, inline: true });
        }
        if (job.jobType && job.jobType !== 'N/A') {
            fields.push({ name: 'Job Type', value: job.jobType, inline: true });
        }
        if (job.postedTime && job.postedTime !== 'N/A') {
            fields.push({ name: 'Posted', value: job.postedTime, inline: true });
        }
        if (job.applicantCount && job.applicantCount !== 'N/A') {
            fields.push({ name: 'Applicants', value: job.applicantCount, inline: true });
        }
         if (job.salary && job.salary !== 'N/A') {
            fields.push({ name: 'Salary', value: job.salary, inline: false }); // Salary might be longer
        }

        // Ensure we don't exceed Discord field limits (max 25)
        while (fields.length > 25) {
            fields.pop();
        }

        // --- Prepare Embed --- 
        const embed = {
            title: finalTitle,
            url: job.link || '#',
            color: 0x0077B5, 
            fields: fields,
            timestamp: new Date().toISOString(),
            footer: { text: 'LinkedIn Job Watcher' }
        };

        // --- Add Thumbnail if URL exists --- 
        if (job.companyLogoUrl) {
            embed.thumbnail = { url: job.companyLogoUrl };
        }

        await axios.post(discordWebhookUrl, { username: 'LinkedIn Job Bot', embeds: [embed] });
        console.log(`Successfully sent job ID ${job.id} to Discord.`);
        return true;
    } catch (error) {
        console.error(`Error sending job ID ${job.id} to Discord:`, error.response?.data || error.message);
        return false;
    }
}

/**
 * Marks a job ID as sent by adding to the set and appending to the file.
 * @param {string} jobId 
 */
async function markJobAsSent(jobId) {
    sentJobIdsThisRun.add(jobId);
    try {
        await fs.appendFile(SENT_JOBS_FILE, `${jobId}\n`);
        console.log(`Marked job ID ${jobId} as sent.`);
    } catch (err) {
        console.error(`Error writing job ID ${jobId} to ${SENT_JOBS_FILE}:`, err);
    }
}

/**
 * Clears the sent jobs file and the in-memory set.
 */
async function clearSentJobs() {
    sentJobIdsThisRun.clear();
    try {
        await fs.writeFile(SENT_JOBS_FILE, ''); // Overwrite with empty content
        console.log(`Cleared sent jobs file: ${SENT_JOBS_FILE}`);
    } catch (err) {
        console.error(`Error clearing sent jobs file ${SENT_JOBS_FILE}:`, err);
    }
}

/**
 * Scrapes the first N job listings, clicking each for details if it's new.
 * Sends notification immediately upon finding a new job.
 * Returns the count of newly sent jobs.
 */
async function scrapeFirstNJobs(page, count) {
    console.log(`Checking first ${count} job listings for new jobs...`);
    let newlySentCount = 0;
    const jobCardSelector = 'li[data-occludable-job-id]';
    const jobDetailPaneSelector = '.jobs-search__job-details--container';
    const detailTitleSelector = '.job-details-jobs-unified-top-card__job-title h1 a';

    try {
        console.log(`Waiting for job cards ('${jobCardSelector}')...`);
        await page.waitForSelector(jobCardSelector, { state: 'visible', timeout: 30000 });
        await page.waitForTimeout(1000); 

        const allJobCards = await page.locator(jobCardSelector).all();
        const totalCards = allJobCards.length;
        console.log(`Found ${totalCards} job cards. Processing first ${Math.min(count, totalCards)}.`);
        
        const jobCardsToCheck = allJobCards.slice(0, Math.min(count, totalCards));

        for (let i = 0; i < jobCardsToCheck.length; i++) {
            const card = jobCardsToCheck[i];
            const logPrefix = `Card ${i + 1}:`;
            let jobId = null; 

            try {
                jobId = await card.getAttribute('data-occludable-job-id');
                if (!jobId) {
                    console.warn(`${logPrefix} No job ID found on card. Skipping.`);
                    continue;
                }
                console.log(`${logPrefix} Found Job ID: ${jobId}`);

                // --- Check if job is new BEFORE scraping details ---
                if (!sentJobIdsThisRun.has(jobId)) {
                    console.log(`${logPrefix} Job ID ${jobId} is NEW. Processing details...`);
                    
                    // Initialize detail variables here
                    let listTitle = 'N/A', company = 'N/A', location = 'N/A', link = '#';
                    let workplaceType = 'N/A', jobType = 'N/A', salary = 'N/A', postedTime = 'N/A', applicantCount = 'N/A';
                    let companyLogoUrl = null; 
                    let isEasyApply = false; 

                    await card.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(200); 

                    const titleLinkLocator = card.locator('a.job-card-list__title--link').first();
                    try {
                        await titleLinkLocator.waitFor({ state: 'visible', timeout: 5000 });
                    } catch (visError) {
                        console.error(`${logPrefix} Card link not visible even though job ID was found. Skipping new job. Error: ${visError.message}`);
                        continue; 
                    }

                    // --- Extract workplace type from card location BEFORE clicking ---
                    try {
                        const cardLocationText = await safeGetText(card.locator('.job-card-container__metadata-wrapper span').first(), 2000);
                        console.log(`${logPrefix} Card location text: "${cardLocationText}"`);
                        if (cardLocationText !== 'N/A' && cardLocationText.includes('(')) {
                            const workplaceMatch = cardLocationText.match(/\(([^)]+)\)/);
                            if (workplaceMatch) {
                                const extractedWorkplace = workplaceMatch[1].trim();
                                if (['Remote', 'Hybrid', 'On-site', 'On-Site'].includes(extractedWorkplace)) {
                                    workplaceType = extractedWorkplace === 'On-Site' ? 'On-site' : extractedWorkplace;
                                    console.log(`${logPrefix} Extracted workplace type from card: "${workplaceType}"`);
                                }
                            }
                        }
                    } catch (cardLocationError) {
                        console.warn(`${logPrefix} Could not extract workplace type from card location: ${cardLocationError.message}`);
                    }

                    // --- Title Extraction ---
                    let titleFromStrong = 'N/A', titleFromAria = null, finalTitle = 'N/A';
                    try { titleFromStrong = await safeGetText(card.locator('.job-card-list__title strong').first(), 2000); } catch { /*ignore*/ }
                    if (titleFromStrong === 'N/A') { 
                        try { titleFromAria = await safeGetAttribute(titleLinkLocator, 'aria-label', 2000); } catch { /*ignore*/ }
                    }
                    if (titleFromStrong !== 'N/A') finalTitle = titleFromStrong;
                    else if (titleFromAria) finalTitle = titleFromAria;
                    if (finalTitle !== 'N/A') {
                         listTitle = finalTitle.trim().replace(/\s+/g, ' ').replace(/ with verification$/i, '').trim();
                    } else {
                        listTitle = 'N/A'; 
                    }
                    console.log(`${logPrefix} Final Cleaned Title: "${listTitle}"`);
                    // --- End Title ---

                    // --- Extract workplace type from card location BEFORE clicking ---
                    try {
                        const cardLocationText = await safeGetText(card.locator('.job-card-container__metadata-wrapper span').first(), 2000);
                        console.log(`${logPrefix} Card location text: "${cardLocationText}"`);
                        if (cardLocationText !== 'N/A' && cardLocationText.includes('(')) {
                            const workplaceMatch = cardLocationText.match(/\(([^)]+)\)/);
                            if (workplaceMatch) {
                                const extractedWorkplace = workplaceMatch[1].trim();
                                if (['Remote', 'Hybrid', 'On-site', 'On-Site'].includes(extractedWorkplace)) {
                                    workplaceType = extractedWorkplace === 'On-Site' ? 'On-site' : extractedWorkplace;
                                    console.log(`${logPrefix} Extracted workplace type from card: "${workplaceType}"`);
                                }
                            }
                        }
                    } catch (cardLocationError) {
                        console.warn(`${logPrefix} Could not extract workplace type from card location: ${cardLocationError.message}`);
                    }

                    link = await titleLinkLocator.getAttribute('href', { timeout: 3000 }) || '#';
                    if (link.startsWith('/')) link = `https://www.linkedin.com${link}`;
                    console.log(`${logPrefix} Link: ${link}`);

                    // --- Click card and get details ---
                    console.log(`${logPrefix} Clicking card to load details...`);
                    await card.click();
                    try {
                        const detailPane = page.locator(jobDetailPaneSelector);
                        await detailPane.waitFor({ state: 'visible', timeout: 10000 });
                        console.log(`${logPrefix} Detail pane visible. Waiting for detail title...`);
                        await page.waitForSelector(detailTitleSelector, { state: 'visible', timeout: 10000 });
                        console.log(`${logPrefix} Detail title loaded.`);
                        
                        const detailContainer = page.locator(jobDetailPaneSelector);
                        company = await safeGetText(detailContainer.locator('.job-details-jobs-unified-top-card__company-name a').first());
                        companyLogoUrl = await safeGetAttribute(detailContainer.locator('.job-details-jobs-unified-top-card__company-name a img').first(), 'src', 2000);
                        if (!companyLogoUrl) companyLogoUrl = await safeGetAttribute(detailContainer.locator('.ivm-image-view-model img').first(), 'src', 2000);

                        const tertiaryDescContainer = detailContainer.locator('.job-details-jobs-unified-top-card__tertiary-description-container'); 
                        let rawLocation = await safeGetText(tertiaryDescContainer.locator('span.tvm__text').first(), 3000); 
                        
                        // Extract workplace type from location string if not already found from card (e.g., "Bellevue, WA (Remote)" -> "Remote")
                        if (workplaceType === 'N/A' && rawLocation !== 'N/A' && rawLocation.includes('(')) {
                            const workplaceMatch = rawLocation.match(/\(([^)]+)\)/);
                            if (workplaceMatch) {
                                const extractedWorkplace = workplaceMatch[1].trim();
                                if (['Remote', 'Hybrid', 'On-site', 'On-Site'].includes(extractedWorkplace)) {
                                    workplaceType = extractedWorkplace === 'On-Site' ? 'On-site' : extractedWorkplace;
                                    // Remove workplace type from location string
                                    location = rawLocation.replace(/\s*\([^)]+\)\s*$/, '').trim();
                                    console.log(`${logPrefix} Extracted workplace type from detail pane location: "${workplaceType}", cleaned location: "${location}"`);
                                } else {
                                    location = rawLocation; // Keep original if pattern doesn't match expected values
                                }
                            } else {
                                location = rawLocation; // No parentheses found, use as-is
                            }
                        } else if (rawLocation !== 'N/A') {
                            // If workplace type already found from card, just clean the location
                            if (rawLocation.includes('(')) {
                                location = rawLocation.replace(/\s*\([^)]+\)\s*$/, '').trim();
                            } else {
                                location = rawLocation;
                            }
                        } else {
                            location = rawLocation; // Use raw location if extraction failed
                        }
                        
                        const tertiaryDescText = await safeGetText(tertiaryDescContainer, 5000); 
                        console.log(`${logPrefix} Raw Tertiary Desc Text: "${tertiaryDescText}"`);
                        if (tertiaryDescText !== 'N/A') {
                            const timeMatch = tertiaryDescText.match(/(\d+\s+\w+(?:\s+ago)?|\bYesterday\b|\bToday\b)/i); 
                            const applicantMatch = tertiaryDescText.match(/((?:Over |under |Be the first to apply|)\d*\s*applicant)s?/i); 
                            postedTime = timeMatch ? timeMatch[0].trim() : 'N/A';
                            applicantCount = applicantMatch ? applicantMatch[0].trim() : 'N/A';
                            console.log(`${logPrefix} Regex Matches - Posted: ${postedTime}, Applicants: ${applicantCount}`);
                        }

                        // Try to get workplace type from preference pills if not already found
                        salary = 'N/A'; 
                        jobType = 'N/A';
                        
                        // First, try to extract salary from job-details-fit-level-preferences buttons (most reliable)
                        try {
                            const fitLevelButtons = detailContainer.locator('.job-details-fit-level-preferences button').all();
                            const buttons = await fitLevelButtons;
                            for (const button of buttons) {
                                const buttonText = await safeGetText(button, 2000);
                                if (buttonText !== 'N/A' && (buttonText.includes('$') || buttonText.toLowerCase().includes('k/yr') || buttonText.toLowerCase().includes('/hr') || buttonText.toLowerCase().includes('per hour') || buttonText.toLowerCase().includes('per year'))) {
                                    salary = buttonText.trim();
                                    console.log(`${logPrefix} Found salary from fit-level-preferences: "${salary}"`);
                                    break; // Found salary, no need to check other sources
                                }
                            }
                        } catch (fitLevelError) { 
                            console.warn(`${logPrefix} Error locating fit-level-preferences buttons: ${fitLevelError.message}`); 
                        }
                        
                        // If salary not found, try preference pills
                        if (salary === 'N/A') {
                            try {
                                const skillsButton = detailContainer.locator('button.job-details-preferences-and-skills');
                                const skillPills = await skillsButton.locator('.job-details-preferences-and-skills__pill').all();
                                for (const pill of skillPills) {
                                    const pillText = await safeGetText(pill.locator('span.ui-label'), 2500);
                                    if (pillText !== 'N/A') {
                                        // Only set workplaceType if we haven't found it yet
                                        if (workplaceType === 'N/A' && ['Remote', 'Hybrid', 'On-site', 'On-Site'].includes(pillText)) {
                                            workplaceType = pillText === 'On-Site' ? 'On-site' : pillText;
                                            console.log(`${logPrefix} Found workplace type from pill: "${workplaceType}"`);
                                        } else if (['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Volunteer'].some(jt => pillText.includes(jt))) {
                                            const match = pillText.match(/(Full-time|Part-time|Contract|Temporary|Internship|Volunteer)/i);
                                            if (match) jobType = match[0];
                                        } else if (pillText.includes('$') || pillText.toLowerCase().includes('k/yr') || pillText.toLowerCase().includes('/hr') || pillText.toLowerCase().includes('per hour') || pillText.toLowerCase().includes('per year')) {
                                            salary = pillText.trim();
                                            console.log(`${logPrefix} Found salary from preference pill: "${salary}"`);
                                        }
                                    }
                                }
                            } catch (pillError) { console.warn(`${logPrefix} Error locating or processing preference pills: ${pillError.message}`); }
                        }
                        
                        // If salary still not found, try extracting from job card metadata as fallback
                        if (salary === 'N/A') {
                            try {
                                const cardMetadata = card.locator('.job-card-container__metadata-wrapper span').first();
                                const metadataText = await safeGetText(cardMetadata, 2000);
                                if (metadataText !== 'N/A' && (metadataText.includes('$') || metadataText.toLowerCase().includes('k/yr') || metadataText.toLowerCase().includes('/hr'))) {
                                    // Extract just the salary part (might include benefits like "$50/hr · 401(k), +1 benefit" or "$53.85/hr - $63.85/hr")
                                    // Try to match full range first, then single value
                                    const salaryMatch = metadataText.match(/(\$[\d,]+(?:\.[\d]+)?\s*(?:\/hr|\/hour|k\/yr|per hour|per year)(?:\s*-\s*\$[\d,]+(?:\.[\d]+)?\s*(?:\/hr|\/hour|k\/yr|per hour|per year))?)/i) ||
                                                       metadataText.match(/(\$[\d,]+(?:\.[\d]+)?\s*(?:\/hr|\/hour|k\/yr|per hour|per year))/i);
                                    if (salaryMatch) {
                                        salary = salaryMatch[0].trim();
                                        console.log(`${logPrefix} Found salary from card metadata: "${salary}"`);
                                    }
                                }
                            } catch (cardMetadataError) { 
                                console.warn(`${logPrefix} Error extracting salary from card metadata: ${cardMetadataError.message}`); 
                            }
                        }

                        try {
                            const easyApplyButton = detailContainer.locator('button.jobs-apply-button:has-text("Easy Apply")').first();
                            if (await easyApplyButton.isVisible({ timeout: 2000 })) {
                                isEasyApply = true;
                                console.log(`${logPrefix} Easy Apply button found.`);
                            }
                        } catch { console.log(`${logPrefix} Easy Apply button check failed or button not found.`); }

                    } catch (detailWaitError) {
                        console.warn(`${logPrefix} Detail pane or title did not load/update in time. Skipping detail scrape for new job. Error: ${detailWaitError.message}`);
                        // Essential details like title/link might still be valid, attempt to send anyway? Or skip?
                        // Let's skip sending if details couldn't be reliably fetched.
                        console.warn(`${logPrefix} Skipping send for Job ID ${jobId} due to detail scraping issues.`);
                        continue; // Skip to the next card in the main loop
                    }
                    // --- End Detail Scraping --- 

                    // --- Prepare and Send New Job --- 
                    console.log(`${logPrefix} FINAL DETAILS for NEW job ${jobId}: Company='${company}', Location='${location}', Workplace='${workplaceType}', Type='${jobType}', Salary='${salary}', Posted='${postedTime}', Applicants='${applicantCount}', EasyApply=${isEasyApply}, LogoURL='${companyLogoUrl}'`);
                    
                    if (jobId && listTitle !== 'N/A') {
                        // Check if job matches filter keywords (if configured)
                        if (!matchesFilterKeywords(listTitle)) {
                            console.log(`${logPrefix} Job title "${listTitle}" does not match filter keywords. Skipping webhook.`);
                            // Still mark as sent so we don't check it again
                            await markJobAsSent(jobId);
                            continue;
                        }
                        
                         const job = {
                            id: jobId,
                            title: listTitle,
                            company: company,
                            location: location,
                            link: link,
                            workplaceType: workplaceType,
                            jobType: jobType,
                            salary: salary,
                            postedTime: postedTime,
                            applicantCount: applicantCount,
                            companyLogoUrl: companyLogoUrl, 
                            isEasyApply: isEasyApply
                        };
                        
                        const success = await sendToDiscord(job);
                        if (success) {
                            await markJobAsSent(jobId); // Use jobId here
                            newlySentCount++;
                        } else {
                            console.warn(`${logPrefix} Failed to send Job ID ${jobId} to Discord. It will be retried on the next cycle unless manually added to sent_jobs.txt.`);
                        }
                    } else {
                         console.warn(`${logPrefix} SKIPPING SEND for new Job ID ${jobId} due to missing essential list data (Title was 'N/A').`);
                    }
                    // --- End Send New Job ---

                } else {
                    // Job ID was already in sentJobIdsThisRun
                    console.log(`${logPrefix} Job ID ${jobId} already sent this run. Skipping.`);
                    continue; // Skip to the next card
                }

            } catch (error) {
                // Catch errors specific to processing a single card
                console.error(`${logPrefix} UNEXPECTED error processing card (Job ID: ${jobId || 'unknown'}): ${error.message}`);
                 // Continue to the next card even if one fails unexpectedly
            }
            
            // Optional small delay between processing cards, even if skipped
            await page.waitForTimeout(50 + Math.random() * 100);

        } // --- End For Loop --- 

    } catch (error) {
        // Catch errors related to finding cards or the main scraping block setup
        console.error(`Error in scrapeFirstNJobs main block: ${error.message}`);
    }

    console.log(`Scraping cycle finished. Sent ${newlySentCount} new jobs.`);
    return newlySentCount;
}


// --- Main Execution Logic --- 

async function main() {
    const targetUrl = buildLinkedInSearchUrl(); 
    console.log('--- LinkedIn Job Watcher ---');
    console.log(`Configured URL: ${targetUrl}`);
    console.log(`Workplace Filter: ${searchWorkplaceType || 'Any'}`);
    console.log(`Job Function Filter: ${searchJobFunctions || 'Any'}`);
    console.log(`Industry Filter: ${searchIndustries || 'Any'}`);
    console.log(`Title Filter Keywords: ${filterKeywords || 'None (all jobs included)'}`);
    console.log(`Refresh Interval: ${refreshIntervalSeconds} seconds`);
    console.log(`Cards to Check per Refresh: ${CARDS_TO_CHECK}`);
    console.log(`User Data Dir: ${chromeUserDataDir || 'No (temporary profile)'}`);
    console.log(`Sent Jobs File: ${SENT_JOBS_FILE}`);
    console.log('-----------------------------');

    // Clear sent jobs file and set at the start
    await clearSentJobs();

    let browserContext;
    let browser;
    let page;
    let monitoringInterval = null; 

    try {
        // --- Browser Setup --- 
        const launchOptions = {
            headless: isHeadless, // Controlled by command line argument (-headless or --headless)
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled']
        };
        
        console.log(`Running in ${isHeadless ? 'headless' : 'headed'} mode (browser will ${isHeadless ? 'not ' : ''}be visible).`);
        if (args.length > 0 && !isHeadless) {
            console.log('Note: To run in headless mode, use: npm start -- --headless or npm run start:headless');
        }

        if (chromeUserDataDir) {
            console.log('Launching browser with persistent context...');
            browserContext = await chromium.launchPersistentContext(chromeUserDataDir, launchOptions);
            const pages = browserContext.pages();
            page = pages.length > 0 ? pages[0] : await browserContext.newPage();
            console.log(pages.length > 0 ? 'Using existing page.' : 'Created new page in context.');
        } else {
            console.log('Launching new browser instance...');
            browser = await chromium.launch(launchOptions);
            browserContext = browser; 
            page = await browser.newPage();
            console.log('Created new page.');
        }
        page.setDefaultTimeout(60000);

        // --- Navigation & Login --- 
        console.log('Navigating to target URL...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }); 
        console.log('Initial page loaded.');

        const loginIndicatorSelector = '#ember20'; 
        let isLoggedIn = false;
        try {
            console.log(`Checking login status ('${loginIndicatorSelector}')...`);
            await page.waitForSelector(loginIndicatorSelector, { state: 'visible', timeout: 20000 }); 
            isLoggedIn = await page.locator(loginIndicatorSelector).isVisible();
        } catch (e) { /* Assume not logged in */ }
        
        if (!isLoggedIn) {
            console.log('Login required. Please log in and navigate to the job search page in the browser.');
            console.log('Press Enter here when ready...');
            await new Promise(resolve => process.stdin.once('data', resolve));
            console.log('Continuing after manual login confirmation...');
        } else {
            console.log('Already logged in.');
        }

        // --- Initial Scrape & Send --- 
        console.log('--- Performing Initial Check & Send ---');
        // scrapeFirstNJobs now handles checking and sending internally
        const initialSentCount = await scrapeFirstNJobs(page, CARDS_TO_CHECK); 
        console.log(`--- Initial Check Complete - Sent ${initialSentCount} new jobs ---`);
       
        // --- Start Monitoring Loop --- 
        console.log(`Starting monitoring loop. Refreshing every ${refreshIntervalSeconds} seconds.`);
        monitoringInterval = setInterval(async () => {
            try {
                console.log(`--- Refreshing & Checking (${new Date().toLocaleTimeString()}) ---`);
                
                // Try reload first, with fallback to navigation if it fails
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                    console.log('Page reloaded. Checking for new jobs...');
                } catch (reloadError) {
                    // If reload fails (e.g., page detached, navigation aborted), try navigating to the URL again
                    if (reloadError.message.includes('detached') || 
                        reloadError.message.includes('ERR_ABORTED') ||
                        reloadError.message.includes('Target closed') ||
                        reloadError.message.includes('Target page, context or browser has been closed')) {
                        console.warn(`Reload failed (${reloadError.message}). Attempting to navigate to URL instead...`);
                        try {
                            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                            console.log('Navigated to target URL. Checking for new jobs...');
                        } catch (navError) {
                            // If navigation also fails, try to get a new page
                            console.warn(`Navigation also failed (${navError.message}). Attempting to get a new page...`);
                            if (browserContext) {
                                try {
                                    const pages = browserContext.pages();
                                    if (pages.length > 0) {
                                        page = pages[0];
                                        console.log('Using existing page from context.');
                                    } else {
                                        page = await browserContext.newPage();
                                        console.log('Created new page.');
                                    }
                                    page.setDefaultTimeout(60000);
                                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                                    console.log('Navigated to target URL on new page.');
                                } catch (recoveryError) {
                                    throw new Error(`Failed to recover page: ${recoveryError.message}`);
                                }
                            } else {
                                throw new Error('Browser context is not available for recovery.');
                            }
                        }
                    } else {
                        // Re-throw if it's a different type of error
                        throw reloadError;
                    }
                }
                
                // scrapeFirstNJobs now handles checking and sending internally
                const newlySentCount = await scrapeFirstNJobs(page, CARDS_TO_CHECK); 
                console.log(`Refresh check complete. Sent ${newlySentCount} new jobs this cycle.`);

            } catch (intervalError) {
                console.error(`Error during monitoring interval: ${intervalError.message}`);
                if (intervalError.stack) {
                    console.error(`Call log:\n${intervalError.stack.split('\n').slice(0, 5).join('\n')}`);
                }
                if (intervalError.message.includes('Target page, context or browser has been closed') || 
                    intervalError.message.includes('Target closed') ||
                    intervalError.message.includes('Browser closed')) {
                    console.error('Browser/Page closed unexpectedly. Stopping monitoring.');
                    clearInterval(monitoringInterval);
                    process.exit(1); 
                } else {
                    console.error('Attempting to continue monitoring despite error.');
                    // Try to recover by getting a new page if possible
                    try {
                        if (browserContext) {
                            const pages = browserContext.pages();
                            if (pages.length > 0) {
                                page = pages[0];
                                console.log('Recovered by using existing page from context.');
                            } else {
                                page = await browserContext.newPage();
                                console.log('Recovered by creating a new page.');
                            }
                            page.setDefaultTimeout(60000);
                            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                            console.log('Recovered and navigated to target URL.');
                        }
                    } catch (recoveryError) {
                        console.error(`Recovery attempt failed: ${recoveryError.message}`);
                    }
                }
            }
        }, refreshIntervalSeconds * 1000);

        // Keep script running while interval is active
        console.log('Monitoring active. Press Ctrl+C to stop.');
        await new Promise(resolve => process.on('SIGINT', resolve));

    } catch (error) {
        console.error('--- A critical error occurred in main ---');
        console.error(error);
    } finally {
        console.log('--- Shutting down ---');
        if (monitoringInterval) {
            clearInterval(monitoringInterval);
            console.log('Stopped monitoring interval.');
        }
        if (browserContext && typeof browserContext.close === 'function' && !chromeUserDataDir) {
             await browserContext.close(); 
             console.log('Closed launched browser.');
         } else if (browserContext) {
             console.log('Persistent browser context left open.'); 
         } else {
            console.log('No active browser context to close.');
        }
        console.log('Shutdown complete.');
        process.exit(0); 
    }
}

main(); 