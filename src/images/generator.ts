import { Character } from "../characters";
import { logger } from "../logger";
import { MS2ImageProvider } from "./providers/ms2";
import { PollinationsProvider } from "./providers/pollinations";
import { ImageProvider } from "./types";

const providers: Record<string, ImageProvider> = {
  ms2: new MS2ImageProvider(),
  pollinations: new PollinationsProvider(),
};

export async function generateImageForTweet(
  imagePrompt: string,
  character: Character,
): Promise<Buffer> {
  const provider =
    providers[character.imageGenerationBehavior?.provider || "pollinations"];
  if (!provider) {
    throw new Error(
      `Image provider not found: ${character.imageGenerationBehavior?.provider}`,
    );
  }

  logger.info("Using image provider:", provider);
  return await provider.generateImage(imagePrompt, character);
}
