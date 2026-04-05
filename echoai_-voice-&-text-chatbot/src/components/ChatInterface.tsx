import { useState, useEffect, useRef } from "react";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { Mic, MicOff, Send, MessageSquare, Volume2, VolumeX, Sparkles, Trash2, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/src/lib/utils";
import { VoiceVisualizer } from "./VoiceVisualizer";

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

interface Message {
  id: string;
  role: "user" | "model";
  text: string;
  timestamp: Date;
}

export default function Chatbot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState(true);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageIdCounter = useRef(0);

  useEffect(() => {
    const checkApiKey = async () => {
      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      }
    };
    checkApiKey();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  const addMessage = (role: "user" | "model", text: string, mode: "new" | "append" | "replace" = "new") => {
    if (!text && mode !== "replace") return;

    setMessages(prev => {
      const last = prev[prev.length - 1];
      
      if (mode === "append" && last && last.role === role) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text: last.text + text };
        return updated;
      }

      if (mode === "replace" && last && last.role === role) {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text };
        return updated;
      }

      if (mode === "new" && last && last.role === role && last.text === text) return prev;
      
      messageIdCounter.current += 1;
      const uniqueId = `${Date.now()}-${messageIdCounter.current}-${Math.random().toString(36).substr(2, 5)}`;
      
      return [...prev, {
        id: uniqueId,
        role,
        text,
        timestamp: new Date()
      }];
    });
  };

  const startAudioProcessing = (stream: MediaStream, context: AudioContext) => {
    try {
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      const updateVolume = () => {
        if (!isListening) return;
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        setVolume(average / 128);
        requestAnimationFrame(updateVolume);
      };
      updateVolume();

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        
        const uint8 = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64Data = btoa(binary);
        
        if (sessionRef.current && isListening) {
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" }
          }).catch((err: any) => console.error("Error sending audio:", err));
        }
      };

      source.connect(processor);
      processor.connect(context.destination);
      processorRef.current = processor;
    } catch (err) {
      console.error("Audio processing error:", err);
    }
  };

  const stopAudioCapture = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    processorRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current = null;
    processorRef.current = null;
    audioContextRef.current = null;
    setVolume(0);
  };

  const playAudio = async (base64Data: string) => {
    if (!audioContextRef.current) return;
    
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x7FFF;
    
    const buffer = audioContextRef.current.createBuffer(1, float32.length, 16000);
    buffer.getChannelData(0).set(float32);
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.start();
  };

  const startSession = async () => {
    try {
      setStatus("connecting");
      setErrorMsg(null);

      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        if (!selected) {
          setStatus("idle");
          await window.aistudio.openSelectKey();
          setHasApiKey(true);
          return;
        }
      }

      if (!window.isSecureContext) {
        throw new Error("Microphone access requires a secure (HTTPS) connection.");
      }

      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
      } catch (micErr: any) {
        console.warn("Mic access denied", micErr);
        setErrorMsg("Microphone access denied. Please enable it in your browser settings.");
        setStatus("idle");
        return;
      }
      
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) throw new Error("Gemini API Key is not configured.");

      const ai = new GoogleGenAI({ apiKey });
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are EchoAI, a friendly real-time voice assistant. Keep responses concise. You excel at speech-to-text and natural dialogue.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus("active");
            setIsListening(true);
            const context = new AudioContext({ sampleRate: 16000 });
            audioContextRef.current = context;
            if (streamRef.current) startAudioProcessing(streamRef.current, context);
          },
          onmessage: async (message: any) => {
            const serverContent = message.serverContent;
            if (!serverContent) return;

            if (serverContent.modelTurn?.parts) {
              serverContent.modelTurn.parts.forEach((p: any) => {
                if (p.text) addMessage("model", p.text, "append");
                if (p.inlineData?.data && !isMuted) playAudio(p.inlineData.data);
              });
            }

            if (serverContent.userTurn?.parts) {
              const userText = serverContent.userTurn.parts.map((p: any) => p.text).filter(Boolean).join("");
              if (userText) addMessage("user", userText, "replace");
            }
          },
          onerror: (err: any) => {
            console.error("Live API Error:", err);
            setStatus("error");
            if (err?.message?.includes("Requested entity was not found")) {
              setErrorMsg("API Key issue. Please select a valid API key.");
              if (window.aistudio) window.aistudio.openSelectKey();
            } else {
              setErrorMsg("Connection error: " + (err instanceof Error ? err.message : "Unknown error"));
            }
          },
          onclose: () => {
            setStatus("idle");
            stopAudioCapture();
            setIsListening(false);
          }
        }
      });

      sessionRef.current = session;
    } catch (err: any) {
      console.error("Failed to start session:", err);
      setStatus("error");
      setErrorMsg(err.message || "Failed to start session");
    }
  };

  const stopSession = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    stopAudioCapture();
    setIsListening(false);
    setStatus("idle");
  };

  const [isTyping, setIsTyping] = useState(false);
  const chatRef = useRef<any>(null);

  const handleSendMessage = async () => {
    if (!inputText.trim()) return;
    
    const userMessage = inputText.trim();
    addMessage("user", userMessage);
    setInputText("");
    setErrorMsg(null);

    // If live session is active, send via live API
    if (sessionRef.current && status === "active") {
      sessionRef.current.sendRealtimeInput({ text: userMessage });
      return;
    }

    // Otherwise, use standard Chat API
    setIsTyping(true);
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) throw new Error("Gemini API Key is not configured.");

      const ai = new GoogleGenAI({ apiKey });
      
      if (!chatRef.current) {
        chatRef.current = ai.chats.create({
          model: "gemini-3-flash-preview",
          config: {
            systemInstruction: "You are EchoAI, a helpful and friendly AI assistant. Respond with clear, well-formatted markdown.",
          },
        });
      }

      const result = await chatRef.current.sendMessageStream({
        message: userMessage,
      });

      let firstChunk = true;
      for await (const chunk of result) {
        const response = chunk as any;
        const text = response.text;
        if (text) {
          if (firstChunk) {
            addMessage("model", text);
            firstChunk = false;
          } else {
            addMessage("model", text, "append");
          }
        }
      }
    } catch (err: any) {
      console.error("Chat error:", err);
      setErrorMsg("Failed to get response: " + (err.message || "Unknown error"));
    } finally {
      setIsTyping(false);
    }
  };

  const clearChat = () => setMessages([]);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Header */}
      <header className="p-6 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">EchoAI</h1>
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <span className={cn("w-2 h-2 rounded-full", 
                status === 'active' ? 'bg-green-500 animate-pulse' : 
                status === 'connecting' ? 'bg-yellow-500' : 'bg-slate-600'
              )} />
              {status === 'active' ? 'Live' : status === 'connecting' ? 'Connecting...' : 'Offline'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <button 
            onClick={clearChat}
            className="p-2 rounded-full hover:bg-slate-800 transition-colors text-slate-400"
            title="Clear Chat"
          >
            <Trash2 className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
        <AnimatePresence initial={false}>
          {errorMsg && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl text-sm mb-4">
              {errorMsg}
            </motion.div>
          )}
          
          {messages.length === 0 ? (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="h-full flex flex-col items-center justify-center text-center space-y-6 max-w-md mx-auto">
              <div className="w-16 h-16 rounded-full bg-slate-900 flex items-center justify-center mb-2">
                <MessageSquare className="w-8 h-8 text-blue-500" />
              </div>
              <h2 className="text-2xl font-semibold">Welcome to EchoAI</h2>
              <p className="text-slate-400">
                Start a conversation by clicking the microphone button. I can hear you and respond in real-time.
              </p>
              
              {!hasApiKey && (
                <button onClick={handleSelectKey} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-all shadow-lg shadow-blue-500/20">
                  Select API Key
                </button>
              )}
            </motion.div>
          ) : (
            messages.map((msg) => (
              <motion.div key={msg.id} initial={{ opacity: 0, x: msg.role === 'user' ? 20 : -20 }} animate={{ opacity: 1, x: 0 }} className={cn("flex w-full", msg.role === 'user' ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] p-4 rounded-2xl shadow-sm", msg.role === 'user' ? "bg-blue-600 text-white rounded-tr-none" : "bg-slate-900 text-slate-100 rounded-tl-none border border-slate-800")}>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </main>

      {/* Controls */}
      <footer className="p-8 border-t border-slate-800 bg-slate-900/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto flex items-center gap-6">
          <button
            onClick={isListening ? stopSession : startSession}
            disabled={status === 'connecting'}
            className={cn(
              "w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-xl",
              isListening 
                ? "bg-red-500 hover:bg-red-600 shadow-red-500/20" 
                : "bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
            )}
          >
            {status === 'connecting' ? (
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            ) : isListening ? (
              <MicOff className="w-8 h-8 text-white" />
            ) : (
              <Mic className="w-8 h-8 text-white" />
            )}
          </button>

          <div className="flex-1 flex flex-col gap-3">
            <div className="h-12 bg-slate-800/50 rounded-xl overflow-hidden border border-slate-700/50">
              <VoiceVisualizer volume={volume} isActive={isListening} />
            </div>
            <div className="relative">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder="Type a message..."
                className="w-full bg-slate-800 border border-slate-700 rounded-xl py-3 px-5 pr-12 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
              />
              <button
                onClick={handleSendMessage}
                disabled={!inputText.trim() || isTyping}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-blue-500 hover:text-blue-400 disabled:opacity-50"
              >
                {isTyping ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <button
            onClick={() => setIsMuted(!isMuted)}
            className={cn(
              "p-4 rounded-xl border transition-all",
              isMuted ? "border-red-500/50 text-red-500 bg-red-500/5" : "border-slate-700 text-slate-400 hover:bg-slate-800"
            )}
          >
            {isMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
          </button>
        </div>
        <p className="text-center text-[10px] text-slate-500 mt-4 uppercase tracking-widest">
          Gemini 3.1 Flash Live API
        </p>
      </footer>
    </div>
  );
}
