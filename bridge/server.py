#!/usr/bin/env python3
"""
Meshtastic Bridge HTTP Server
Wraps the meshtastic Python library and exposes HTTP + SSE endpoints
for OpenClaw to communicate with Meshtastic mesh radios.
"""

import os
import sys
import time
import json
import queue
import logging
import threading
from typing import Optional, Dict, Any
from datetime import datetime

import meshtastic
import meshtastic.serial_interface
from flask import Flask, request, jsonify, Response

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Global state
interface: Optional[meshtastic.serial_interface.SerialInterface] = None
message_queue = queue.Queue(maxsize=100)
device_path = os.getenv("MESHTASTIC_DEVICE", "/dev/ttyUSB0")
connection_lock = threading.Lock()
last_error: Optional[str] = None


def on_receive(packet, interface):
    """Callback for incoming Meshtastic packets"""
    try:
        # Only handle text messages for MVP
        if 'decoded' not in packet:
            return
        
        decoded = packet['decoded']
        if decoded.get('portnum') != 'TEXT_MESSAGE_APP':
            return
        
        # Extract message data
        from_id = packet.get('fromId', 'unknown')
        to_id = packet.get('toId', 'broadcast')
        text = decoded.get('text', '')
        rx_time = packet.get('rxTime', int(time.time()))
        
        # Get sender name if available
        from_name = from_id
        if interface and hasattr(interface, 'nodes'):
            node = interface.nodes.get(from_id)
            if node and 'user' in node:
                user_info = node['user']
                from_name = user_info.get('longName', user_info.get('shortName', from_id))
        
        # Channel index: 0 = primary/public, 1-7 = secondary channels
        channel_index = packet.get('channel', 0)
        
        # A message is a DM if toId is a specific node (not broadcast) AND on channel 0
        # Public channel messages have toId='^all' or 'broadcast' OR are on channel > 0
        is_broadcast = to_id in ('broadcast', '^all', '!ffffffff')
        is_direct = not is_broadcast and channel_index == 0
        
        msg_data = {
            'type': 'text',
            'from': from_id,
            'fromName': from_name,
            'to': to_id,
            'text': text,
            'timestamp': rx_time,
            'channel': channel_index,
            'isDirect': is_direct,
        }
        
        ch_label = f"ch{channel_index}" if not is_direct else "DM"
        logger.info(f"📨 [{ch_label}] Message from {from_name} ({from_id}): {text[:50]}")
        
        # Queue for SSE stream
        try:
            message_queue.put_nowait(msg_data)
        except queue.Full:
            logger.warning("Message queue full, dropping oldest message")
            try:
                message_queue.get_nowait()
                message_queue.put_nowait(msg_data)
            except:
                pass
                
    except Exception as e:
        logger.error(f"Error in on_receive callback: {e}", exc_info=True)


def connect_to_device():
    """Connect to Meshtastic device via serial"""
    global interface, last_error
    
    with connection_lock:
        if interface:
            try:
                interface.close()
            except:
                pass
            interface = None
        
        try:
            logger.info(f"🔌 Connecting to Meshtastic device at {device_path}...")
            interface = meshtastic.serial_interface.SerialInterface(
                devPath=device_path,
                noProto=False
            )
            
            # Subscribe to text messages
            from pubsub import pub
            pub.subscribe(on_receive, "meshtastic.receive.text")
            
            # Get basic info
            if interface.myInfo:
                my_node_id = interface.myInfo.my_node_num
                logger.info(f"✅ Connected! My node: {my_node_id}")
            
            last_error = None
            return True
            
        except Exception as e:
            last_error = str(e)
            logger.error(f"❌ Failed to connect to {device_path}: {e}")
            interface = None
            return False


def ensure_connected():
    """Ensure we have an active connection, reconnect if needed"""
    global interface
    
    if interface is None:
        return connect_to_device()
    
    # Check if connection is alive
    try:
        # Try to access myInfo to verify connection
        _ = interface.myInfo
        return True
    except:
        logger.warning("Connection lost, attempting to reconnect...")
        return connect_to_device()


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    is_connected = interface is not None
    
    status = {
        'status': 'connected' if is_connected else 'disconnected',
        'device': device_path,
        'error': last_error,
        'timestamp': int(time.time())
    }
    
    if is_connected and interface.myInfo:
        try:
            status['nodeId'] = getattr(interface.myInfo, 'my_node_num', None)
        except:
            pass
    
    return jsonify(status), 200 if is_connected else 503


@app.route('/info', methods=['GET'])
def info():
    """Get device info (my node ID, firmware, etc.)"""
    if not ensure_connected():
        return jsonify({'error': 'Not connected to device'}), 503
    
    try:
        my_info = interface.myInfo
        metadata = interface.metadata if hasattr(interface, 'metadata') else {}
        
        info_data = {
            'myNodeId': getattr(my_info, 'my_node_num', None),
            'firmware': metadata.get('firmware_version', 'unknown'),
            'device': device_path,
        }
        
        # Try to get own node info
        if hasattr(interface, 'nodes') and interface.myInfo:
            my_node_num = interface.myInfo.my_node_num
            if my_node_num in interface.nodes:
                node = interface.nodes[my_node_num]
                if 'user' in node:
                    user = node['user']
                    info_data['longName'] = user.get('longName')
                    info_data['shortName'] = user.get('shortName')
        
        return jsonify(info_data)
        
    except Exception as e:
        logger.error(f"Error getting device info: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/nodes', methods=['GET'])
def nodes():
    """List known mesh nodes"""
    if not ensure_connected():
        return jsonify({'error': 'Not connected to device'}), 503
    
    try:
        node_list = []
        
        if hasattr(interface, 'nodes'):
            for node_id, node_data in interface.nodes.items():
                node_info = {
                    'id': node_id,
                    'num': node_data.get('num'),
                }
                
                if 'user' in node_data:
                    user = node_data['user']
                    node_info['longName'] = user.get('longName')
                    node_info['shortName'] = user.get('shortName')
                    node_info['hwModel'] = user.get('hwModel')
                
                if 'position' in node_data:
                    pos = node_data['position']
                    node_info['position'] = {
                        'latitude': pos.get('latitude'),
                        'longitude': pos.get('longitude'),
                        'altitude': pos.get('altitude'),
                    }
                
                if 'lastHeard' in node_data:
                    node_info['lastHeard'] = node_data['lastHeard']
                
                node_list.append(node_info)
        
        return jsonify({'nodes': node_list})
        
    except Exception as e:
        logger.error(f"Error listing nodes: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/send', methods=['POST'])
def send_message():
    """Send text message to mesh network"""
    if not ensure_connected():
        return jsonify({'error': 'Not connected to device'}), 503
    
    try:
        data = request.get_json()
        text = data.get('text')
        to = data.get('to')  # Node ID or None for broadcast
        channel_index = data.get('channelIndex', 0)
        
        if not text:
            return jsonify({'error': 'Missing "text" field'}), 400
        
        logger.info(f"📤 Sending message to {to or 'broadcast'}: {text[:50]}")
        
        # Send message
        interface.sendText(
            text=text,
            destinationId=to,
            channelIndex=channel_index
        )
        
        return jsonify({'ok': True, 'sent': True})
        
    except Exception as e:
        logger.error(f"Error sending message: {e}")
        return jsonify({'error': str(e), 'ok': False}), 500


@app.route('/messages', methods=['GET'])
def messages_stream():
    """Server-Sent Events stream of incoming messages"""
    def generate():
        # Send initial connection event
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        
        while True:
            try:
                # Wait for message with timeout to allow periodic heartbeats
                msg = message_queue.get(timeout=30)
                yield f"data: {json.dumps(msg)}\n\n"
            except queue.Empty:
                # Send heartbeat to keep connection alive
                yield f": heartbeat\n\n"
            except Exception as e:
                logger.error(f"Error in SSE stream: {e}")
                break
    
    return Response(generate(), mimetype='text/event-stream')


def init_connection():
    """Initialize connection on startup"""
    logger.info("🚀 Starting Meshtastic Bridge Server")
    connect_to_device()


if __name__ == '__main__':
    # Connect to device before starting server
    init_connection()
    
    # Start Flask server
    port = int(os.getenv('PORT', '5000'))
    app.run(host='0.0.0.0', port=port, threaded=True)
