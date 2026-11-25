// Meetings feature (stream B3): meeting notes, action items and Markdown export
// run inside this user's DS-Bot; data in /data/flybot-workspace/features/meetings.
import { defineFeature } from '../../featurekit/feature.js'
import { spec } from './meetings.js'

export default defineFeature(spec)
