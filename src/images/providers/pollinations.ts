import { Character } from "../../characters";
import { logger } from "../../logger";
import { ImageProvider } from "../types";

export class PollinationsProvider implements ImageProvider {
  async generateImage(prompt: string, character: Character): Promise<Buffer> {
    const imageUrl = `https://image.pollinations.ai/prompt/${prompt}`;
    logger.info("imageUrl:", imageUrl);
    return await this.downloadImage(imageUrl);
  }

  private async downloadImage(imageUrl: string): Promise<Buffer> {
    const response = await fetch(imageUrl);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
