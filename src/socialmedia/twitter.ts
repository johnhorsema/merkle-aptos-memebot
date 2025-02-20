import * as fs from "fs";
import { Scraper, SearchMode } from "goat-x";
import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

import {
  calcEntryByPaySize,
  calcPriceImpactInfo,
  Decimals,
  fromNumber,
  MerkleClient,
  MerkleClientConfig,
} from "@merkletrade/ts-sdk";
import {
  Account,
  Aptos,
  Ed25519PrivateKey,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import { Character } from "../characters";
import {
  generateImagePromptForCharacter,
  generateReply,
  generateTopicPost,
  generateTopicPostForTrade,
  generateTweetSummary,
} from "../completions";
import { saveTweet as saveTweet, getTweetByInputTweetId } from "../database";
import { generateImageForTweet } from "../images";
import { logger } from "../logger";
import { randomInterval } from "../utils";
import { CleanedTweet } from "./types";
import {
  formatTwitterHistoryForPrompt,
  getConversationHistory,
  getTwitterHistory,
  getTwitterHistoryByUsername,
  getUserInteractionCount,
  TwitterHistory,
} from "../database/tweets";
import {
  storeTweetEmbedding,
  isTweetTooSimilar,
} from "../embeddings/tweet-embeddings";
import { LevelOrString } from "pino";
interface Mention {
  id: string;
  user: string;
  created_at: Date;
  text: string;
  user_id_str: string;
  conversation_id?: string;
}

interface TwitterCreateTweetResponse {
  data?: {
    create_tweet: {
      tweet_results: {
        result: {
          rest_id: string;
        };
      };
    };
  };
  errors?: Array<{
    message: string;
    code: string;
  }>;
}

export class TwitterProvider {
  private scraper: Scraper;
  private character: Character;
  private account: Account;
  private client: MerkleClient;
  private aptos: Aptos;
  private session: WSAPISession;
  private latest1mPrice: PriceFeed[];
  private priceGapRatePercent: number;

  constructor(character: Character) {
    this.character = character;
    this.scraper = new Scraper();
  }

  public async login() {
    await this.scraper.login(
      this.character.username,
      this.character.twitterPassword,
      this.character.twitterEmail ? this.character.twitterEmail : undefined,
    );
    const cookies = await this.scraper.getCookies();
    fs.writeFileSync(
      `cookies/cookies_${this.character.username}.json`,
      JSON.stringify(cookies, null, 2),
    );
    logger.info(`Successfully wrote cookies for ${this.character.username}`);
  }

  public async initWithCookies() {
    const cookiesText = fs.readFileSync(
      `./cookies/cookies_${this.character.username}.json`,
      "utf8",
    );
    const cookiesArray = JSON.parse(cookiesText);
    const cookieStrings = cookiesArray?.map(
      (cookie: any) =>
        `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${
          cookie.path
        }; ${cookie.secure ? "Secure" : ""}; ${
          cookie.httpOnly ? "HttpOnly" : ""
        }; SameSite=${cookie.sameSite || "Lax"}`,
    );
    await this.scraper.setCookies(cookieStrings);
    return this;
  }

  public async startTopicPosts() {
    const defaultBound = 30;
    const {
      topicInterval = 45 * 60 * 1000, // 45 minutes default
      lowerBoundPostingInterval = defaultBound,
      upperBoundPostingInterval = defaultBound,
    } = this.character.postingBehavior;

    const lowerBound = topicInterval - lowerBoundPostingInterval * 60 * 1000;
    const upperBound = topicInterval + upperBoundPostingInterval * 60 * 1000;

    try {
      await this.generateTimelinePost();
      randomInterval(() => this.generateTimelinePost(), lowerBound, upperBound);
    } catch (error: unknown) {
      logger.error("Error writing topic post:", error);
    }
  }

  public async startAutoResponder() {
    const defaultBound = 60;
    const lowerBound =
      this.character.postingBehavior.replyInterval ||
      15 * 60 * 1000 - // 15 minutes default
        (this.character.postingBehavior.lowerBoundPostingInterval ||
          defaultBound) *
          60 *
          1000;
    const upperBound =
      this.character.postingBehavior.replyInterval ||
      15 * 60 * 1000 +
        (this.character.postingBehavior.upperBoundPostingInterval ||
          defaultBound) *
          60 *
          1000;

    await this.generateTimelineResponse();
    randomInterval(
      async () => await this.generateTimelineResponse(),
      lowerBound,
      upperBound,
    );
  }

  public async startReplyingToMentions() {
    const defaultBound = 2;
    const lowerBound =
      10 * 60 * 1000 - // 10 minutes default
      (this.character.postingBehavior.lowerBoundPostingInterval ||
        defaultBound) *
        60 *
        1000;
    const upperBound =
      10 * 60 * 1000 +
      (this.character.postingBehavior.upperBoundPostingInterval ||
        defaultBound) *
        60 *
        1000;

    await this.replyToMentions();
    randomInterval(
      async () => await this.replyToMentions(),
      lowerBound,
      upperBound,
    );
  }

  private async generateTimelinePost() {
    logger.info(
      `Calling generateTimelinePost for ${this.character.username} at ${new Date().toLocaleString()}`,
    );

    try {
      let completion;
      let isSimilar = true;
      let attemptCount = 0;
      const maxAttempts = 2;

      // while (isSimilar && attemptCount < maxAttempts) {
      //   completion = await generateTopicPost(this.character);
      //   logger.info("LLM completion attempt done.");

      //   isSimilar = await isTweetTooSimilar(completion.reply);
      //   if (isSimilar) {
      //     logger.warn(
      //       `Generated tweet is too similar, retrying... Attempt ${attemptCount + 1}`,
      //     );
      //   }
      //   attemptCount++;
      // }

      // if (isSimilar) {
      //   logger.error("Max attempts reached. Skipping tweet generation.");
      //   return;
      // }

      let news = await axios.get(
        "https://cryptopanic.com/api/free/v1/posts/?auth_token=bc1b634d2699dbfdb96ff50f54cfdb6e9f031570&currencies=APT&filter=hot",
      );
      completion = await generateTopicPost(this.character, news.data);

      if (completion) {
        let sendTweetResponse;

        const shouldGenerateImage =
          this.character.postingBehavior.generateImagePrompt &&
          Math.random() <
            (this.character.postingBehavior.imagePromptChance || 0.3);

        logger.debug(`shouldGenerateImage: ${shouldGenerateImage}`);

        if (shouldGenerateImage) {
          try {
            const imageBuffer =
              await this.generateImageForTwitterPost(completion);
            sendTweetResponse = await this.sendTweetWithMedia(
              completion.reply,
              imageBuffer,
            );
          } catch (e) {
            logger.error("Error sending tweet with image:", e);
            // Fallback to sending tweet without image
            logger.info("Falling back to sending tweet without image");
            sendTweetResponse = await this.scraper.sendTweet(completion.reply);
          }
        } else {
          sendTweetResponse = await this.scraper.sendTweet(completion.reply);
        }

        if (!sendTweetResponse) {
          throw new Error("Failed to send tweet - no response received");
        }

        const responseJson =
          (await sendTweetResponse.json()) as TwitterCreateTweetResponse;
        if (!responseJson.data?.create_tweet) {
          logger.error("An error occurred:", { responseJson });
          return;
        }

        const newTweetId =
          responseJson.data.create_tweet.tweet_results.result.rest_id;
        logger.info(`The reply tweet was sent: ${newTweetId}`);

        saveTweet(this.character.username, {
          input_tweet_id: "",
          input_tweet_created_at: "",
          input_tweet_text: "",
          input_tweet_user_id: "",
          input_tweet_username: "",
          new_tweet_id: newTweetId,
          prompt: completion.prompt,
          new_tweet_text: completion.reply,
        });

        // Store tweet embedding
        const tweetTextSummary = await generateTweetSummary(
          this.character,
          completion.reply,
        );
        if (tweetTextSummary) {
          await storeTweetEmbedding(
            this.character.username,
            newTweetId,
            completion.reply,
            tweetTextSummary,
            new Date().toISOString(),
          );
        }
        logger.info("A row was inserted into the database.\n");
      }
    } catch (e: any) {
      logger.error(`There was an error: ${e}`);
      logger.error("e.message", e.message);
    }
  }

  private async generateTradingPost(trades: String, data: any) {
    logger.info(
      `Calling generateTradingPost for ${this.character.username} at ${new Date().toLocaleString()}`,
    );

    try {
      let completion;
      let isSimilar = true;
      let attemptCount = 0;
      const maxAttempts = 2;

      // while (isSimilar && attemptCount < maxAttempts) {
      //   completion = await generateTopicPost(this.character);
      //   logger.info("LLM completion attempt done.");

      //   isSimilar = await isTweetTooSimilar(completion.reply);
      //   if (isSimilar) {
      //     logger.warn(
      //       `Generated tweet is too similar, retrying... Attempt ${attemptCount + 1}`,
      //     );
      //   }
      //   attemptCount++;
      // }

      // if (isSimilar) {
      //   logger.error("Max attempts reached. Skipping tweet generation.");
      //   return;
      // }

      completion = await generateTopicPostForTrade(
        this.character,
        trades,
        data,
      );

      if (completion) {
        let sendTweetResponse;

        const shouldGenerateImage =
          this.character.postingBehavior.generateImagePrompt &&
          Math.random() <
            (this.character.postingBehavior.imagePromptChance || 0.3);

        logger.debug(`shouldGenerateImage: ${shouldGenerateImage}`);

        if (shouldGenerateImage) {
          try {
            const imageBuffer =
              await this.generateImageForTwitterPost(completion);
            sendTweetResponse = await this.sendTweetWithMedia(
              completion.reply,
              imageBuffer,
            );
          } catch (e) {
            logger.error("Error sending tweet with image:", e);
            // Fallback to sending tweet without image
            logger.info("Falling back to sending tweet without image");
            sendTweetResponse = await this.scraper.sendTweet(completion.reply);
          }
        } else {
          sendTweetResponse = await this.scraper.sendTweet(completion.reply);
        }

        if (!sendTweetResponse) {
          throw new Error("Failed to send tweet - no response received");
        }

        const responseJson =
          (await sendTweetResponse.json()) as TwitterCreateTweetResponse;
        if (!responseJson.data?.create_tweet) {
          logger.error("An error occurred:", { responseJson });
          return;
        }

        const newTweetId =
          responseJson.data.create_tweet.tweet_results.result.rest_id;
        logger.info(`The reply tweet was sent: ${newTweetId}`);

        saveTweet(this.character.username, {
          input_tweet_id: "",
          input_tweet_created_at: "",
          input_tweet_text: "",
          input_tweet_user_id: "",
          input_tweet_username: "",
          new_tweet_id: newTweetId,
          prompt: completion.prompt,
          new_tweet_text: completion.reply,
        });

        // Store tweet embedding
        const tweetTextSummary = await generateTweetSummary(
          this.character,
          completion.reply,
        );
        if (tweetTextSummary) {
          await storeTweetEmbedding(
            this.character.username,
            newTweetId,
            completion.reply,
            tweetTextSummary,
            new Date().toISOString(),
          );
        }
        logger.info("A row was inserted into the database.\n");
      }
    } catch (e: any) {
      logger.error(`There was an error: ${e}`);
      logger.error("e.message", e.message);
    }
  }

  private async generateTimelineResponse() {
    logger.info(
      `Calling generateTimelineResponse for ${this.character.username} at ${new Date().toLocaleString()}***`,
    );

    try {
      const timeline = await this.getTimeline();
      const filteredTimeline = this.filterTimeline(timeline);
      logger.info(`After filtering, ${filteredTimeline.length} posts remain.`);
      const mostRecentTweet = filteredTimeline.reduce((latest, current) => {
        return new Date(current.created_at) > new Date(latest.created_at)
          ? current
          : latest;
      }, filteredTimeline[0]);

      if (!mostRecentTweet) {
        logger.error("No most recent tweet found");
        return;
      }

      const mostRecentTweetMinutesAgo = Math.round(
        (Date.now() - mostRecentTweet.created_at.getTime()) / 1000 / 60,
      );
      logger.info(
        `The most recent tweet was ${mostRecentTweetMinutesAgo} minutes ago.`,
      );

      const history = getTwitterHistoryByUsername(this.character.username, 10);

      const historyByUser = getTwitterHistory(mostRecentTweet.user_id_str, 10);

      const formattedHistory = formatTwitterHistoryForPrompt(
        history.concat(historyByUser),
      );

      const completion = await generateReply(
        mostRecentTweet.text,
        this.character,
        false,
        formattedHistory,
      );

      logger.info("LLM completion done.");

      const sendTweetResponse = await this.scraper.sendTweet(
        completion.reply,
        mostRecentTweet.id,
      );

      const newTweetJson =
        (await sendTweetResponse.json()) as TwitterCreateTweetResponse;

      if (!newTweetJson.data?.create_tweet) {
        logger.error("An error occurred:", { responseJson: newTweetJson });
        return;
      }

      saveTweet(this.character.username, {
        input_tweet_id: mostRecentTweet.id,
        input_tweet_created_at: mostRecentTweet.created_at.toISOString(),
        input_tweet_text: mostRecentTweet.text,
        input_tweet_user_id: mostRecentTweet.user_id_str,
        input_tweet_username: mostRecentTweet.user,
        new_tweet_id:
          newTweetJson.data.create_tweet.tweet_results.result.rest_id,
        prompt: completion.prompt,
        new_tweet_text: completion.reply,
      });
    } catch (e: any) {
      logger.error(`There was an error: ${e}`);
      logger.error("e.message", e.message);
    }
  }

  private filterTimeline(timeline: CleanedTweet[]) {
    return timeline
      .filter(
        x =>
          !x.text.includes("http") &&
          !this.character.postingBehavior.dontTweetAt?.includes(x.user_id_str),
      )
      .filter(x => getTweetByInputTweetId(x.id) === undefined)
      .filter(x => {
        const interactionCount = getUserInteractionCount(
          x.user_id_str,
          this.character.username,
          this.INTERACTION_TIMEOUT,
        );
        return interactionCount < this.INTERACTION_LIMIT;
      });
  }

  private async replyToMentions() {
    logger.info("Running replyToMentions", new Date().toISOString());
    try {
      const mentions = await this.findMentions(10);
      logger.info(`Found ${mentions.length} mentions`);

      for (const mention of mentions) {
        try {
          if (!mention.text || !mention.id) {
            logger.info(`Skipping mention ${mention.id}: No text or ID`);
            continue;
          }

          const shouldSkip = await this.shouldSkipMention(mention);
          if (shouldSkip) {
            logger.info(
              `Skipping mention ${mention.id}: Already processed or too many interactions`,
            );
            continue;
          }

          logger.info(
            `Processing new mention ${mention.id} from ${mention.user}: ${mention.text}`,
          );

          logger.info("Waiting 15 seconds before replying");
          await new Promise(resolve => setTimeout(resolve, 15000)); // Default delay
          const history = this.getTwitterHistoryByMention(mention);
          const formattedHistory = formatTwitterHistoryForPrompt(
            history,
            false,
          );

          const completion = await generateReply(
            mention.text,
            this.character,
            false,
            formattedHistory,
          );

          logger.info(`Generated reply for ${mention.id}: ${completion.reply}`);

          const sendTweetResponse = await this.scraper.sendTweet(
            completion.reply,
            mention.id,
          );

          const responseJson =
            (await sendTweetResponse.json()) as TwitterCreateTweetResponse;
          if (!responseJson.data?.create_tweet) {
            logger.error("Failed to send tweet:", { responseJson });
            continue;
          }

          const newTweetId =
            responseJson.data.create_tweet.tweet_results.result.rest_id;

          logger.info(`The reply tweet was sent: ${newTweetId}`);

          saveTweet(this.character.username, {
            input_tweet_id: mention.id,
            input_tweet_created_at: mention.created_at.toISOString(),
            input_tweet_text: mention.text,
            input_tweet_user_id: mention.user_id_str,
            input_tweet_username: mention.user,
            new_tweet_id: newTweetId,
            prompt: completion.prompt,
            new_tweet_text: completion.reply,
            conversation_id: mention.conversation_id,
          });
        } catch (e) {
          logger.error(`Error processing mention ${mention.id}:`, e);
          if (e instanceof Error) {
            logger.error("Error stack:", e.stack);
          }
          // Log the mention that failed
          logger.error("Failed mention:", JSON.stringify(mention, null, 2));
        }
      }
    } catch (e) {
      logger.error("Error in replyToMentions:", e);
      if (e instanceof Error) {
        logger.error("Error stack:", e.stack);
      }
    }
    logger.info("Finished replyToMentions", new Date().toISOString());
  }

  private getTwitterHistoryByMention(mention: Mention): TwitterHistory[] {
    let history: TwitterHistory[] = [];
    history.push(...getTwitterHistory(mention.user_id_str, 10));
    if (mention.conversation_id) {
      history.push(...getConversationHistory(mention.conversation_id, 10));
    }
    return history;
  }

  private async shouldSkipMention(mention: Mention) {
    try {
      if (!mention.id || !mention.user_id_str) {
        logger.info(`Skipping mention: Missing ID or user_id_str`);
        return true;
      }

      // Skip if we've already processed this tweet
      const existingTweet = getTweetByInputTweetId(mention.id);
      if (existingTweet) {
        logger.info(`Skipping mention ${mention.id}: Already processed`);
        return true;
      }

      // Get interaction count from twitter_history
      const interactionCount = getUserInteractionCount(
        mention.user_id_str,
        this.character.username,
        this.INTERACTION_TIMEOUT,
      );

      if (interactionCount > this.INTERACTION_LIMIT) {
        logger.info(
          `Skipping mention ${mention.id}: Too many interactions (${interactionCount}) with user ${mention.user_id_str}`,
        );
        return true;
      }

      // Skip if user is in dontTweetAt list
      if (this.character.postingBehavior.dontTweetAt?.includes(mention.user)) {
        logger.info(`Skipping mention ${mention.id}: User in dontTweetAt list`);
        return true;
      }

      return false;
    } catch (e) {
      logger.error(`Error in shouldSkipMention for mention ${mention.id}:`, e);
      if (e instanceof Error) {
        logger.error("Error stack:", e.stack);
      }
      // If there's an error checking, better to skip
      return true;
    }
  }

  private async getTimeline(): Promise<CleanedTweet[]> {
    const tweets = await this.scraper.fetchHomeTimeline(50, []);
    const cleanedTweets = [];

    logger.debug(`Got ${tweets.length} tweets from timeline`);

    for (const tweet of tweets) {
      try {
        const tweetData = tweet.tweet || tweet;
        if (
          !tweetData?.legacy?.full_text ||
          !tweetData?.legacy?.created_at ||
          !tweetData?.rest_id
        ) {
          logger.debug("Malformed tweet data received");
          continue;
        }

        let user_id_str = tweetData.legacy.user_id_str;
        let user = tweetData.legacy.user?.screen_name || "";
        if (!user_id_str) {
          logger.debug("Could not get user info from tweet");
          continue;
        }

        cleanedTweets.push({
          id: tweetData.rest_id,
          created_at: new Date(tweetData.legacy.created_at),
          text: tweetData.legacy.full_text,
          user_id_str,
          user,
        });
      } catch (e) {
        logger.debug("Error processing tweet:", e);
        continue;
      }
    }

    logger.debug(`Returning ${cleanedTweets.length} cleaned tweets`);
    return cleanedTweets;
  }

  private async findMentions(mentionsLimit: number) {
    const query = `@${this.character.username} -from:${this.character.username} -filter:retweets ${this.character.postingBehavior.shouldIgnoreTwitterReplies ? "-filter:replies" : ""}`;
    const mentions = await this.scraper.searchTweets(
      query,
      mentionsLimit,
      SearchMode.Latest,
    );

    const cleanedMentions = [];
    for await (const mention of mentions) {
      if (!mention.username) continue;
      const profile = await this.scraper.getProfile(mention.username);
      if (!profile.followersCount) continue;
      if (profile.followersCount < 50) {
        logger.info(
          `Mention ${mention.id} skipped, user ${mention.username} has less than 50 followers`,
        );
        continue;
      }
      const cleanedMention = {
        id: mention.id,
        user: mention.username,
        created_at: mention.timeParsed,
        text: mention.text,
        user_id_str: mention.userId,
        conversation_id: mention.conversationId,
      } as Mention;
      cleanedMentions.push(cleanedMention);
    }
    return cleanedMentions;
  }

  private async sendTweetWithMedia(text: string, imageBuffer: Buffer) {
    return await this.scraper.sendTweet(text, "", [
      { data: imageBuffer, mediaType: "image/jpeg" },
    ]);
  }

  private async generateImageForTwitterPost(completion: {
    prompt: string;
    reply: string;
  }) {
    let imagePrompt = await generateImagePromptForCharacter(
      completion.reply,
      this.character,
    );
    logger.info(`imagePrompt: ${imagePrompt}`);
    //TODO: Check if imagePrompt was banned here
    const imageBuffer = await generateImageForTweet(
      imagePrompt,
      this.character,
    );
    return imageBuffer;
  }

  private async initListenToPricefeed() {
    // Set Merkle Client
    this.account = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(
        PrivateKey.formatPrivateKey(
          process.env["MERKLE_TRADE_APTOS_PRIVATE_KEY"],
          PrivateKeyVariants.Ed25519,
        ),
      ),
    });

    const config = await MerkleClientConfig.testnet();
    this.client = new MerkleClient(config);
    this.aptos = new Aptos(config.aptosConfig);

    // this.session = await this.client.connectWsApi();
  }

  private async listenToPricefeed() {
    this.latest1mPrice = [];
    try {
      const priceFeed = [
        {
          pair: "BTC_USD",
          price: "96446.16374663",
          ts: 1740001392000,
        },
        {
          pair: "BTC_USD",
          price: "96445.31299873",
          ts: 1740001392001,
        },
        {
          pair: "BTC_USD",
          price: "96446.16374664",
          ts: 1740001393000,
        },
        {
          pair: "BTC_USD",
          price: "96445.21655341",
          ts: 1740001393001,
        },
      ];
      let trades = [];
      for await (const price of priceFeed) {
        this.latest1mPrice = [
          ...this.latest1mPrice.filter(feed => {
            return Date.now() - feed.ts <= 60_000; // 1m
          }),
          price,
        ];

        try {
          let units = Math.random() * 100;
          let buysell = Math.random() > 0.5 ? "BUY" : "SELL";
          let leverage = 250 - Math.random() * 100;
          let percentage = Math.random() * 10;

          trades.push({
            side: buysell,
            position: units,
            leverage: leverage,
            percentage: percentage,
            timestamp: new Date().toLocaleString(),
          });
          logger.info(
            `${buysell} ${units} BTC_USD at ${new Date().toLocaleString()}`,
          );
        } catch (e) {
          logger.error(e);
        }
      }
      const data: any = {
        side: trades[trades.length - 1].side,
        leverage: trades[trades.length - 1].leverage,
        percentage: trades[trades.length - 1].percentage,
        position: trades[trades.length - 1].position,
      };
      this.generateTradingPost(JSON.stringify(trades), data);
    } catch (e) {
      logger.error(e);
    }
  }

  public async startListeningToPricefeed() {
    logger.info(
      `Calling startListeningToPricefeed for ${this.character.username} at ${new Date().toLocaleString()}***`,
    );
    this.initListenToPricefeed();
    this.listenToPricefeed();
  }

  private readonly INTERACTION_LIMIT = 3;
  private readonly INTERACTION_TIMEOUT = 60 * 60 * 1000; // 1 hour in milliseconds
}
