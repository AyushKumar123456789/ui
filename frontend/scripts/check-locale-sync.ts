import fs from 'fs';
import path from 'path';
import { Octokit } from '@octokit/rest';

// Types for better TypeScript support
interface LocaleData {
  [key: string]: any;
}

interface LocaleIssues {
  missing: string[];
  extra: string[];
}

interface LocaleResults {
  [locale: string]: LocaleIssues;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
}

class LocaleSyncChecker {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private localesPath: string;
  private masterLocale: string;
  private issueLabel: string;

  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    
    // Extract owner and repo from GitHub environment
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY environment variable is not set');
    }
    [this.owner, this.repo] = repository.split('/');
    
    this.localesPath = path.join(process.cwd(), 'src', 'locales');
    this.masterLocale = 'en';
    this.issueLabel = 'locale-sync';
  }

  /**
   * Recursively flatten nested JSON objects into dot notation keys
   */
  private flattenObject(obj: any, prefix = ''): string[] {
    const keys: string[] = [];
    
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const newKey = prefix ? `${prefix}.${key}` : key;
        
        if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
          keys.push(...this.flattenObject(obj[key], newKey));
        } else {
          keys.push(newKey);
        }
      }
    }
    
    return keys;
  }

  /**
   * Load and parse a locale JSON file
   */
  private loadLocaleFile(locale: string): LocaleData {
    const filePath = path.join(this.localesPath, `strings.${locale}.json`);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Locale file not found: ${filePath}`);
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to parse locale file ${filePath}: ${error}`);
    }
  }

  /**
   * Get all available locale files
   */
  private getAvailableLocales(): string[] {
    const files = fs.readdirSync(this.localesPath);
    return files
      .filter(file => file.startsWith('strings.') && file.endsWith('.json'))
      .map(file => file.replace('strings.', '').replace('.json', ''))
      .filter(locale => locale !== this.masterLocale);
  }

  /**
   * Compare two sets of keys and return missing and extra keys
   */
  private compareKeys(masterKeys: string[], localeKeys: string[]): LocaleIssues {
    const masterSet = new Set(masterKeys);
    const localeSet = new Set(localeKeys);
    
    const missing = masterKeys.filter(key => !localeSet.has(key));
    const extra = localeKeys.filter(key => !masterSet.has(key));
    
    return { missing, extra };
  }

  /**
   * Check all locale files for synchronization issues
   */
  private checkLocaleSync(): LocaleResults {
    console.log('🔍 Checking locale synchronization...');
    
    // Load master locale
    const masterData = this.loadLocaleFile(this.masterLocale);
    const masterKeys = this.flattenObject(masterData).sort();
    
    console.log(`📋 Master locale (${this.masterLocale}) has ${masterKeys.length} keys`);
    
    const results: LocaleResults = {};
    const availableLocales = this.getAvailableLocales();
    
    console.log(`🌍 Checking ${availableLocales.length} locale files: ${availableLocales.join(', ')}`);
    
    for (const locale of availableLocales) {
      try {
        const localeData = this.loadLocaleFile(locale);
        const localeKeys = this.flattenObject(localeData).sort();
        
        const issues = this.compareKeys(masterKeys, localeKeys);
        results[locale] = issues;
        
        const totalIssues = issues.missing.length + issues.extra.length;
        console.log(`  ${locale}: ${totalIssues} issues (${issues.missing.length} missing, ${issues.extra.length} extra)`);
      } catch (error) {
        console.error(`❌ Error checking locale ${locale}:`, error);
        results[locale] = { missing: [], extra: [] };
      }
    }
    
    return results;
  }

  /**
   * Generate issue title for a specific locale
   */
  private generateIssueTitle(locale: string): string {
    return `[Locale Sync] ${locale.toUpperCase()} translation keys out of sync`;
  }

  /**
   * Generate issue body with detailed information
   */
  private generateIssueBody(locale: string, issues: LocaleIssues): string {
    const { missing, extra } = issues;
    let body = `## 🌍 Locale Synchronization Issue\n\n`;
    body += `The **${locale}** locale file is out of sync with the master English locale.\n\n`;
    
    if (missing.length > 0) {
      body += `### 📝 Missing Keys (${missing.length})\n`;
      body += `The following keys exist in the English locale but are missing in ${locale}:\n\n`;
      body += missing.map(key => `- \`${key}\``).join('\n');
      body += '\n\n';
    }
    
    if (extra.length > 0) {
      body += `### 🗑️ Extra Keys (${extra.length})\n`;
      body += `The following keys exist in ${locale} but not in the English locale:\n\n`;
      body += extra.map(key => `- \`${key}\``).join('\n');
      body += '\n\n';
    }
    
    body += `### 📋 Action Required\n`;
    body += `- [ ] Add missing translations for the keys listed above\n`;
    if (extra.length > 0) {
      body += `- [ ] Review and remove extra keys or add them to the English locale if needed\n`;
    }
    body += `- [ ] Verify the locale file follows the same structure as the English locale\n\n`;
    
    body += `### 📁 File Location\n`;
    body += `\`frontend/src/locales/strings.${locale}.json\`\n\n`;
    
    body += `---\n`;
    body += `*This issue was automatically created by the Locale Synchronization workflow.*\n`;
    body += `*It will be automatically updated when locale files are modified.*`;
    
    return body;
  }

  /**
   * Find existing locale sync issues
   */
  private async findExistingIssues(): Promise<GitHubIssue[]> {
    try {
      const { data: issues } = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: this.issueLabel,
        state: 'open'
      });
      
      return issues.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state as 'open' | 'closed',
        labels: issue.labels.map(label => ({ name: typeof label === 'string' ? label : label.name || '' }))
      }));
    } catch (error) {
      console.error('❌ Error fetching existing issues:', error);
      return [];
    }
  }

  /**
   * Create or update GitHub issue for locale synchronization
   */
  private async createOrUpdateIssue(locale: string, issues: LocaleIssues): Promise<void> {
    const title = this.generateIssueTitle(locale);
    const body = this.generateIssueBody(locale, issues);
    
    try {
      // Check if issue already exists
      const existingIssues = await this.findExistingIssues();
      const existingIssue = existingIssues.find(issue => issue.title === title);
      
      if (existingIssue) {
        // Update existing issue
        await this.octokit.rest.issues.update({
          owner: this.owner,
          repo: this.repo,
          issue_number: existingIssue.number,
          title,
          body
        });
        
        console.log(`✅ Updated existing issue #${existingIssue.number} for ${locale}`);
      } else {
        // Create new issue
        const { data: newIssue } = await this.octokit.rest.issues.create({
          owner: this.owner,
          repo: this.repo,
          title,
          body,
          labels: [this.issueLabel, 'translation', 'bug']
        });
        
        console.log(`🆕 Created new issue #${newIssue.number} for ${locale}`);
      }
    } catch (error) {
      console.error(`❌ Error creating/updating issue for ${locale}:`, error);
    }
  }

  /**
   * Close resolved issues
   */
  private async closeResolvedIssues(results: LocaleResults): Promise<void> {
    const existingIssues = await this.findExistingIssues();
    
    for (const issue of existingIssues) {
      // Extract locale from issue title
      const match = issue.title.match(/\[Locale Sync\] ([A-Z]+) translation keys out of sync/);
      if (!match) continue;
      
      const locale = match[1].toLowerCase();
      const localeResults = results[locale];
      
      // If locale has no issues, close the issue
      if (localeResults && localeResults.missing.length === 0 && localeResults.extra.length === 0) {
        try {
          await this.octokit.rest.issues.update({
            owner: this.owner,
            repo: this.repo,
            issue_number: issue.number,
            state: 'closed'
          });
          
          // Add a comment about the resolution
          await this.octokit.rest.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: issue.number,
            body: `🎉 **Issue Resolved!**\n\nThe ${locale} locale file is now synchronized with the master English locale. All missing and extra keys have been resolved.\n\n*This issue was automatically closed by the Locale Synchronization workflow.*`
          });
          
          console.log(`✅ Closed resolved issue #${issue.number} for ${locale}`);
        } catch (error) {
          console.error(`❌ Error closing issue #${issue.number}:`, error);
        }
      }
    }
  }

  /**
   * Main execution function
   */
  async run(): Promise<void> {
    try {
      console.log('🚀 Starting locale synchronization check...');
      
      // Check if locales directory exists
      if (!fs.existsSync(this.localesPath)) {
        throw new Error(`Locales directory not found: ${this.localesPath}`);
      }
      
      // Check locale synchronization
      const results = this.checkLocaleSync();
      
      // Save results for GitHub Actions
      const resultsPath = path.join(process.cwd(), 'locale-check-results.json');
      fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      
      // Process results
      let hasIssues = false;
      const localesWithIssues: string[] = [];
      
      for (const [locale, issues] of Object.entries(results)) {
        const totalIssues = issues.missing.length + issues.extra.length;
        
        if (totalIssues > 0) {
          hasIssues = true;
          localesWithIssues.push(locale);
          
          // Create or update GitHub issue
          await this.createOrUpdateIssue(locale, issues);
        }
      }
      
      // Close resolved issues
      await this.closeResolvedIssues(results);
      
      // Set GitHub Actions output
      console.log(`::set-output name=has-issues::${hasIssues}`);
      console.log(`::set-output name=affected-locales::${localesWithIssues.join(',')}`);
      
      if (hasIssues) {
        console.log(`⚠️  Found synchronization issues in ${localesWithIssues.length} locale(s): ${localesWithIssues.join(', ')}`);
        console.log('📝 GitHub issues have been created/updated for tracking.');
      } else {
        console.log('✅ All locale files are synchronized!');
      }
      
    } catch (error) {
      console.error('❌ Locale synchronization check failed:', error);
      process.exit(1);
    }
  }
}

// Run the script
if (require.main === module) {
  const checker = new LocaleSyncChecker();
  checker.run();
}