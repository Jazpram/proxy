import { BadRequestError } from "../../../../shared/errors";
import { RequestPreprocessor } from "../index";

/**
 * Throws an error if streaming is requested for models that don't support it
 * (o3-pro, o1-pro, gpt-5-pro and their variants).
 */
export const validateStreaming: RequestPreprocessor = (req) => {
  const { model, stream } = req.body;
  
  // Check if streaming is enabled
  const isStreaming = stream === "true" || stream === true;
  if (!isStreaming) {
    return;
  }
  
  // Check if model is one of the non-streaming models
  const modelStr = String(model).toLowerCase();
  const nonStreamingModels = ["o3-pro", "o1-pro", "gpt-5-pro"];
  
  const isNonStreamingModel = nonStreamingModels.some((modelName) =>
    modelStr.includes(modelName)
  );
  
  if (isNonStreamingModel) {
    throw new BadRequestError(
      "Streaming is not supported for this model. The dev is too lazy to implement it. Please set stream=false."
    );
  }
};