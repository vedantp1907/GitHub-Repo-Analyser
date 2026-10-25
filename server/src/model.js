import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  fullName: { type: String, unique: true, index: true },
  result: mongoose.Schema.Types.Mixed,
  insights: mongoose.Schema.Types.Mixed,
  fetchedAt: { type: Date, default: Date.now },
});
export default mongoose.model('Analysis', schema);
