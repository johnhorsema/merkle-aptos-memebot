import dotenv from "dotenv";
import { Command } from "commander";
import * as commander from "commander";

// Load environment variables at startup
dotenv.config();

import { CHARACTERS } from "./characters/index";
import { TwitterProvider } from "./socialmedia/twitter";

const program = new Command();

program.enablePositionalOptions();

const characterNames = CHARACTERS.map(c => c.username);

program
  .command("generateCookies")
  .description("Generate Twitter cookies for an agent")
  .argument("<username>", "Username of the agent")
  .action(async username => {
    const character = CHARACTERS.find(x => x.username === username);
    if (!character) {
      throw new Error(`Character not found: ${username}`);
    }
    const twitterProvider = new TwitterProvider(
      Object.assign(character, {
        username: process.env["AGENT_TWITTER_EMAIL"],
        twitterPassword: process.env["AGENT_TWITTER_PASSWORD"],
      }),
    );
    await twitterProvider.login();
  });

program
  .command("autoResponder")
  .description("Start auto-responder for Twitter")
  .argument("<username>", "Username of the agent")
  .action(async username => {
    const character = CHARACTERS.find(x => x.username === username);
    if (!character) {
      throw new Error(`Character not found: ${username}`);
    }
    const twitterProvider = new TwitterProvider(character);
    await twitterProvider.initWithCookies();
    await twitterProvider.startAutoResponder();
  });

program
  .command("postMeme")
  .description("Start topic posting for Twitter")
  .argument("<username>", "Username of the agent")
  .action(async username => {
    const character = CHARACTERS.find(x => x.username === username);
    if (!character) {
      throw new Error(`Character not found: ${username}`);
    }
    const twitterProvider = new TwitterProvider(character);
    await twitterProvider.initWithCookies();
    await twitterProvider.startTopicPosts();
  });

program
  .command("replyToMentions")
  .description("Start replying to Twitter mentions")
  .argument("<username>", "Username of the agent")
  .action(async username => {
    const character = CHARACTERS.find(x => x.username === username);
    if (!character) {
      throw new Error(`Character not found: ${username}`);
    }
    const twitterProvider = new TwitterProvider(character);
    await twitterProvider.initWithCookies();
    await twitterProvider.startReplyingToMentions();
  });

program
  .command("listenToPriceFeed+PostMeme")
  .description("Start listneing to BTC_USD pricefeed")
  .argument("<username>", "Username of the agent")
  .action(async username => {
    const character = CHARACTERS.find(x => x.username === username);
    if (!character) {
      throw new Error(`Character not found: ${username}`);
    }
    const twitterProvider = new TwitterProvider(character);
    await twitterProvider.initWithCookies();
    await twitterProvider.startListeningToPricefeed();
  });

program.parse();
