
import axios from 'axios';
import dotenv from 'dotenv';
import {
  getStoredAccessToken,
  getStoredInstagramAccountId,
} from '../integrations/instagram-oauth.service';

dotenv.config();

export interface InstagramUserProfile {
  id?: string;
  username?: string;
  name?: string;
  profile_pic?: string;
  profile_picture_url?: string;
}

export class InstagramService {
  private async resolveAccessToken(): Promise<string | undefined> {
    // Prefer the OAuth-connected professional account token when present.
    const stored = await getStoredAccessToken();
    if (stored) return stored;

    // Refresh env vars in case they changed.
    dotenv.config();

    // Fallback: env-configured Page / Instagram tokens (legacy setup).
    return process.env.INSTAGRAM_PAGE_ACCESS_TOKEN ||
           process.env.FB_PAGE_ACCESS_TOKEN ||
           process.env.INSTAGRAM_ACCESS_TOKEN;
  }

  private getApiVersion(): string {
    return process.env.WHATSAPP_API_VERSION || 'v20.0';
  }

  private async resolveIgUserId(): Promise<string> {
    const storedId = await getStoredInstagramAccountId();
    if (storedId) return storedId;

    return process.env.INSTAGRAM_IG_USER_ID ||
           process.env.INSTAGRAM_PAGE_ID ||
           'me';
  }

  private async buildApiUrl(endpoint: string, token: string): Promise<string> {
    // Classic Facebook Page tokens (EAA...) use graph.facebook.com.
    // Instagram Login / OAuth tokens use graph.instagram.com.
    if (token.startsWith('EAA')) {
      const igUserId = await this.resolveIgUserId();
      return `https://graph.facebook.com/${this.getApiVersion()}/${igUserId}/${endpoint}?access_token=${token}`;
    }

    return `https://graph.instagram.com/${this.getApiVersion()}/me/${endpoint}?access_token=${token}`;
  }

  /**
   * Retrieve the profile of a person who has messaged the Instagram account.
   *
   * The senderId must be the Instagram-scoped user ID received in the webhook.
   * This is different from the ID of the studio's own Instagram account.
   */
  async getUserProfile(senderId: string): Promise<InstagramUserProfile | null> {
    const token = await this.resolveAccessToken();

    if (!token) {
      console.warn('[INSTAGRAM_PROFILE] Cannot retrieve profile: access token is missing.');
      return null;
    }

    const host = token.startsWith('EAA')
      ? 'https://graph.facebook.com'
      : 'https://graph.instagram.com';

    const url = `${host}/${this.getApiVersion()}/${encodeURIComponent(senderId)}`;

    try {
      const response = await axios.get<InstagramUserProfile>(url, {
        params: {
          fields: 'id,name,username,profile_pic',
          access_token: token,
        },
        timeout: 10000,
      });

      const profile = response.data || {};

      return {
        id: profile.id,
        username: profile.username,
        name: profile.name,
        profile_pic: profile.profile_pic,
        profile_picture_url: profile.profile_picture_url,
      };
    } catch (error: any) {
      const status = error.response?.status;
      const metaError = error.response?.data?.error;

      // Do not log the access token.
      console.warn('[INSTAGRAM_PROFILE] Profile lookup failed:', {
        senderId,
        status,
        code: metaError?.code,
        subcode: metaError?.error_subcode,
        message: metaError?.message || error.message,
      });

      return null;
    }
  }

  /**
   * Helper to send a single payload.
   */
  private async sendSingleMessage(
    recipientId: string,
    text: string,
    token: string
  ) {
    const url = await this.buildApiUrl('messages', token);

    try {
      const response = await axios.post(
        url,
        {
          recipient: { id: recipientId },
          message: { text },
        },
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );

      console.log(`Instagram message sent to ${recipientId}: ${response.data.message_id}`);
      return response.data;
    } catch (error: any) {
      console.error(
        'Error sending Instagram message:',
        error.response?.data || error.message
      );
      throw error;
    }
  }

  /**
   * Sends a text message to an Instagram recipient via Facebook/Instagram Graph API.
   */
  async sendMessage(recipientId: string, text: string) {
    const token = await this.resolveAccessToken();

    if (!token) {
      console.error('Instagram Access Token missing (no OAuth connection and no env token)');
      return;
    }

    const MAX_LENGTH = 950;

    if (text.length <= MAX_LENGTH) {
      return this.sendSingleMessage(recipientId, text, token);
    }

    // Chunk long messages without unnecessarily splitting words.
    let remaining = text;

    while (remaining.length > 0) {
      let chunk = remaining.substring(0, MAX_LENGTH);

      if (remaining.length > MAX_LENGTH) {
        const lastNewline = chunk.lastIndexOf('\n');
        const lastSpace = chunk.lastIndexOf(' ');
        const breakPoint = Math.max(lastNewline, lastSpace);

        if (breakPoint > 0) {
          chunk = chunk.substring(0, breakPoint);
        }
      }

      await this.sendSingleMessage(recipientId, chunk.trim(), token);
      remaining = remaining.substring(chunk.length).trim();
    }
  }

  /**
   * Marks a message as read (optional/if supported for IG).
   */
  async markAsRead(recipientId: string) {
    const token = await this.resolveAccessToken();
    if (!token) return;

    const url = await this.buildApiUrl('messages', token);

    try {
      await axios.post(
        url,
        {
          recipient: {
            id: recipientId,
          },
          sender_action: 'mark_seen',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error: any) {
      console.error(
        'Error marking IG message as read:',
        error.response?.data || error.message
      );
    }
  }
}

export const instagramService = new InstagramService();
