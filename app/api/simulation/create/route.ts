/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';
// import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from 'next/server';

import connectDB from '../../../../lib/db/connectDB';
import {
  Simulation, Message
} from '../../../../lib/db/models'

import { SocietySimulationRequest } from '../../../../lib/types/request'

import gemini from '../../../../lib/db/gemini';

// Helper function to generate initial agents
function generateAgents(demographics: SocietySimulationRequest['demographics']): { name: string; details: { [key: string]: any } }[] {
  const agents: { name: string; details: { [key: string]: any } }[] = [];
  let agentCount = 1;
  demographics.forEach(demo => {
    for (let i = 0; i < demo.count; i++) {
      const details: { [key: string]: any } = {};
      if (demo.occupation) details.occupation = demo.occupation;
      if (demo.ageRange) details.ageRange = demo.ageRange;
      if (demo.gender) details.gender = demo.gender;
      if (demo.incomeRange) details.incomeRange = demo.incomeRange;

      agents.push({
        name: `Agent ${agentCount}`,
        details: details,
      });
      agentCount++;
    }
  });
  return agents;
}

export async function POST(req: NextRequest) {
  console.log("create api hit")
  try {
    await connectDB();
    const requestBody = await req.json() as SocietySimulationRequest;

    const model = gemini()

    const simulation = new Simulation(requestBody);
    await simulation.save();
    const simulationId = simulation._id;

    const agents = generateAgents(requestBody.demographics);
    const conversationHistory: { sender: string; content: string }[] = [];

    for (let turn = 1; turn <= agents.length * requestBody.numberOfTurns; turn++) {
      const currentAgentIndex = (turn - 1) % agents.length;
      const currentAgent = agents[currentAgentIndex];

      let context = `You are simulating a society reacting to a new product: ${requestBody.productName} (${requestBody.productDescription}, cost: $${requestBody.productCost}). The initial message was: "${requestBody.exposureMessage}". Here's the current conversation:\n${conversationHistory.length > 0 ? conversationHistory.map(msg => `${msg.sender}: ${msg.content}`).join('\n') : 'No conversation yet'}\n`;
      context += `The next person to speak is ${currentAgent.name}. This persona's traits are: ${Object.entries(currentAgent.details)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('. ')}.`;
      context += ` Think according to this persona's interests and either contribute something new to the chat or agree or argue with previous messages. Do not repeat any message. Entire response must put value to the conversation and be human-like, not a single phrase should be said that suggests the response is generated by an AI. Respond in no more than 40 words, and also estimate the likelihood (in percentage) of this persona buying the product based on their message, enclosed within asterisks (e.g., *50%*); don't include "** **", "\n" or any unnecessary characters anywhere in your response.`;

      const prompt = `${context}\n\n${currentAgent.name} is about to speak.`;

      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const likelihoodMatch = text.match(/\*(\d+)%\*/);
        const purchaseLikelihood = likelihoodMatch ? parseInt(likelihoodMatch[1], 10) : null;
        const messageContent = text

        const newMessage = { sender: currentAgent.name, content: messageContent };
        conversationHistory.push(newMessage);

        console.log(`${currentAgent.name}: ${messageContent} (Likelihood: ${purchaseLikelihood}%)`);

        const message = new Message({
          simulationId: simulationId,
          turn: turn,
          sender: currentAgent.name,
          senderDetails: currentAgent.details,
          content: messageContent,
          purchaseLikelihood: purchaseLikelihood,
        });
        await message.save();

      } catch (error: any) {
        console.error("Error generating message:", error);
        return NextResponse.json({ error: 'Error generating message' }, { status: 500 });
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return NextResponse.json({ status: 'completed', simulation, conversation: conversationHistory });

  } catch (error: any) {
    console.error("Error processing request:", error);
    return NextResponse.json({ error: error||"failed to process the request" }, { status: 500 });
  }
}