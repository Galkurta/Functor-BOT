const fs = require("fs").promises;
const axios = require("axios");
const displayBanner = require("./config/banner");
const colors = require("./config/colors");
const CountdownTimer = require("./config/countdown");
const logger = require("./config/logger");

const CONFIG = {
  API: {
    BASE_URL: "https://apix.securitylabs.xyz/v1",
    ENDPOINTS: {
      USERS: "/users",
      GET_BALANCE: (userId) => `/users/get-balance/${userId}`,
      EARN: (userId) => `/users/earn/${userId}`,
    },
  },
  HEADERS: {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,eng;q=0.7",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Sec-Fetch-Mode": "cors",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  TIMING: {
    CHECK_IN_INTERVAL: 24 * 60 * 60 * 1000,
    REQUEST_DELAY: 2000,
    ACCOUNT_DELAY: 5000,
  },
};

class Account {
  constructor(tokens) {
    this.tokens = tokens;
    this.userId = null;
    this.lastCheckIn = null;
    this.status = "pending";
  }
}

class AutomationBot {
  constructor() {
    this.accounts = new Map();
    this.api = axios.create({
      baseURL: CONFIG.API.BASE_URL,
      headers: CONFIG.HEADERS,
      timeout: 10000,
    });
    this.isShuttingDown = false;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async loadAccounts() {
    try {
      const content = await fs.readFile("data.txt", "utf8");
      const lines = content.split("\n").filter((line) => line.trim());

      lines.forEach((line) => {
        const tokens = line.split(",").map((token) => token.trim());
        if (tokens.length > 0) {
          const account = new Account(tokens);
          this.accounts.set(line, account);
        }
      });

      logger.success(
        `${colors.success}Loaded ${
          this.accounts.size
        } accounts with ${lines.reduce(
          (sum, line) => sum + line.split(",").length,
          0
        )} total tokens${colors.reset}`
      );
      return this.accounts.size > 0;
    } catch {
      logger.warn(
        `${colors.warning}No accounts found or error reading data.txt${colors.reset}`
      );
      return false;
    }
  }

  async getUserInfo(token) {
    try {
      const response = await this.api.get(CONFIG.API.ENDPOINTS.USERS, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.data.id;
    } catch (error) {
      return null;
    }
  }

  async checkBalance(userId, token) {
    const response = await this.api.get(
      CONFIG.API.ENDPOINTS.GET_BALANCE(userId),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data.dipTokenBalance;
  }

  async performCheckIn(userId, token) {
    try {
      const response = await this.api.get(CONFIG.API.ENDPOINTS.EARN(userId), {
        headers: { Authorization: `Bearer ${token}` },
      });
      return {
        success: true,
        data: response.data,
      };
    } catch {
      return { success: false };
    }
  }

  calculateTimeRemaining(lastCheckIn) {
    const nextCheckIn = new Date(lastCheckIn);
    nextCheckIn.setHours(nextCheckIn.getHours() + 24);
    const now = new Date();
    const diff = nextCheckIn - now;

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    return { hours, minutes, seconds };
  }

  async processToken(
    token,
    accountNumber,
    totalAccounts,
    tokenIndex,
    totalTokens
  ) {
    try {
      const userId = await this.getUserInfo(token);
      if (!userId) {
        logger.warn(
          `${colors.warning}Failed to get user info for account ${accountNumber}/${totalAccounts} (token ${tokenIndex}/${totalTokens})${colors.reset}`
        );
        return { error: true, status: "error" };
      }

      try {
        const tokenParts = token.split(".");
        const tokenData = JSON.parse(
          Buffer.from(tokenParts[1], "base64").toString()
        );

        const expTimestamp = tokenData.exp;
        const expDate = new Date(expTimestamp * 1000);

        const expFormatted = expDate.toLocaleString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        logger.info(
          `${colors.info}Processing account ${accountNumber}/${totalAccounts} (token ${tokenIndex}/${totalTokens}): ${colors.accountInfo}${userId}${colors.reset}`
        );
        logger.info(
          `${colors.info}Token expiration: ${colors.accountInfo}${expFormatted}${colors.reset}`
        );
      } catch (e) {
        logger.info(
          `${colors.info}Processing account ${accountNumber}/${totalAccounts} (token ${tokenIndex}/${totalTokens}): ${colors.accountInfo}${userId}${colors.reset}`
        );
      }

      const initialBalance = await this.checkBalance(userId, token);
      logger.info(
        `${colors.info}Initial balance: ${colors.faucetInfo}${initialBalance}${colors.reset}`
      );

      const checkInResult = await this.performCheckIn(userId, token);

      if (!checkInResult.success) {
        const lastCheckInTime = new Date();
        lastCheckInTime.setHours(lastCheckInTime.getHours() - 1);
        const { hours, minutes, seconds } =
          this.calculateTimeRemaining(lastCheckInTime);
        logger.warn(
          `${colors.warning}Check-in cooldown: ${hours}h ${minutes}m ${seconds}s remaining${colors.reset}`
        );
        return {
          userId,
          token,
          lastCheckIn: lastCheckInTime,
          status: "cooldown",
        };
      }

      const updatedBalance = await this.checkBalance(userId, token);
      logger.success(
        `${colors.success}Check-in successful! New balance: ${colors.faucetSuccess}${updatedBalance}${colors.reset}`
      );
      return {
        userId,
        token,
        lastCheckIn: new Date(),
        status: "success",
      };
    } catch (error) {
      logger.error(
        `${colors.error}Failed to process account ${accountNumber}/${totalAccounts} (token ${tokenIndex}/${totalTokens})${colors.reset}`
      );
      return { error: true, status: "error" };
    }
  }

  async processAccount(account, accountNumber, totalAccounts) {
    const results = [];
    const tokens = account.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const result = await this.processToken(
        tokens[i],
        accountNumber,
        totalAccounts,
        i + 1,
        tokens.length
      );

      results.push(result);

      if (i < tokens.length - 1) {
        await this.sleep(CONFIG.TIMING.REQUEST_DELAY);
      }
    }

    return {
      tokens: account.tokens,
      results: results,
      status: results.some((r) => r.status === "success")
        ? "success"
        : results.some((r) => r.status === "cooldown")
        ? "cooldown"
        : "error",
    };
  }

  async runCycle() {
    try {
      const hasAccounts = await this.loadAccounts();
      if (!hasAccounts) return;

      let accountNumber = 1;
      const totalAccounts = this.accounts.size;
      let processedAccounts = [];

      for (const [_, account] of this.accounts) {
        const result = await this.processAccount(
          account,
          accountNumber,
          totalAccounts
        );

        processedAccounts.push(result);

        if (accountNumber < totalAccounts) {
          await this.sleep(CONFIG.TIMING.ACCOUNT_DELAY);
        }

        accountNumber++;
      }

      const successCount = processedAccounts.filter(
        (a) => a.status === "success"
      ).length;
      const cooldownCount = processedAccounts.filter(
        (a) => a.status === "cooldown"
      ).length;
      const errorCount = processedAccounts.filter(
        (a) => a.status === "error"
      ).length;

      const totalTokens = processedAccounts.reduce(
        (sum, account) => sum + account.tokens.length,
        0
      );
      const successfulTokens = processedAccounts.reduce(
        (sum, account) =>
          sum + account.results.filter((r) => r.status === "success").length,
        0
      );

      logger.success(
        `${colors.success}Cycle completed - Accounts: Success: ${successCount}, Cooldown: ${cooldownCount}, Error: ${errorCount}${colors.reset}`
      );
      logger.success(
        `${colors.success}Tokens processed: ${successfulTokens}/${totalTokens} successful${colors.reset}`
      );
    } catch (error) {
      logger.error(
        `${colors.error}Cycle interrupted, will retry in next run${colors.reset}`
      );
    }
  }

  async start() {
    displayBanner();

    while (!this.isShuttingDown) {
      await this.runCycle();

      logger.warn(
        `${colors.warning}Waiting 24 hours before next cycle...${colors.reset}`
      );

      let remainingSeconds = 24 * 60 * 60;

      while (remainingSeconds > 0 && !this.isShuttingDown) {
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;

        const timeString = [
          hours.toString().padStart(2, "0"),
          minutes.toString().padStart(2, "0"),
          seconds.toString().padStart(2, "0"),
        ].join(":");

        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(
          `${colors.timerCount}Next cycle in: ${colors.timerWarn}${timeString}${colors.reset}`
        );

        await this.sleep(1000);
        remainingSeconds--;
      }

      if (this.isShuttingDown) break;
      process.stdout.write("\n");
    }
  }
}

const bot = new AutomationBot();

process.on("SIGINT", async () => {
  bot.isShuttingDown = true;
  process.stdout.write("\n");
  console.log(`${colors.warning}Gracefully shutting down...${colors.reset}`);
  process.exit(0);
});

process.on("unhandledRejection", () => {});

bot.start().catch(() => {
  process.exit(1);
});
