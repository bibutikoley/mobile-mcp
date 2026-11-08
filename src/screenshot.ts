import { ActionableError, Dimensions, Robot, ScreenshotOptions } from "./robot";
import { getJpegDimensions } from "./jpeg";
import { PNG } from "./png";

export interface CapturedScreenshot {
	buffer: Buffer;
	mimeType: "image/jpeg" | "image/png";
	size: Dimensions;
}

/**
 * Takes a screenshot and reads its real size from the image header. mobilecli
 * returns the requested format and size; legacy robots ignore the options and
 * return a full-size png, so the format is detected rather than assumed.
 */
export const captureScreenshot = async (robot: Robot, options: ScreenshotOptions): Promise<CapturedScreenshot> => {
	const buffer = await robot.getScreenshot(options);

	const isJpeg = buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
	let mimeType: CapturedScreenshot["mimeType"] = "image/jpeg";
	let size: Dimensions;
	if (isJpeg) {
		size = getJpegDimensions(buffer);
	} else {
		mimeType = "image/png";

		// validate we received a png, will throw exception otherwise
		size = new PNG(buffer).getDimensions();
	}

	if (size.width <= 0 || size.height <= 0) {
		throw new ActionableError("Screenshot is invalid. Please try again.");
	}

	return { buffer, mimeType, size };
};
