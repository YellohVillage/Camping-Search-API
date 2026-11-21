import { createLambdaHandler } from './adapters/lambda.js';
import { getApp } from './bootstrap.js';

/** Point d'entrée AWS Lambda (bundle dist/lambda.js, handler `lambda.handler`). */
export const handler = createLambdaHandler(() => getApp());
