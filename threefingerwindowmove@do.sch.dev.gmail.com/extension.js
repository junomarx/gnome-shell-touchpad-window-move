const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Lang = imports.lang;
const Signals = imports.signals;
const GObject = imports.gi.GObject;

const EDGE_THRESHOLD = 48;

const SnapAction = {
	NONE: 0,
	MAXIMIZE: 1,
	TILE_LEFT: 2,
	TILE_RIGHT: 4
};

let gestureHandler = null;

const TouchpadGestureAction = class{

    constructor(actor) {
        this._gestureCallbackID = actor.connect('captured-event', Lang.bind(this, this._handleEvent));
        
        const deviceManager = Clutter.DeviceManager.get_default();
        this._virtualTouchpad = deviceManager.create_virtual_device(Clutter.InputDeviceType.TOUCHPAD_DEVICE);
        this._virtualKeyboard = deviceManager.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        
        this._monitorGeometry = null;
        this._posRect = new Meta.Rectangle({x:0, y:0, width: 1, height: 1});
        this._previewRect = new Meta.Rectangle({x:0, y:0, width: 0, height: 0});
        
        this._movingMetaWindow = null;
        this._pointerWindowDiffX = 0;
        this._pointerWindowDiffY = 0;
	this._pointerDiffX = 0;
	this._pointerDiffY = 0;
	this._nextSnapAction = SnapAction.NONE;
	
	this._sizeHandler = null;
	this._unmanagedHandler = null;
	this._workspaceChangedHandler = null;
    }
    
    _handleEvent(actor, event) {
    
    	// Only look for touchpad swipes
        if (event.type() != Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;
            
    	// Only look for three finger gestures
        if (event.get_touchpad_gesture_finger_count() != 3)
            return Clutter.EVENT_PROPAGATE;
            
        // Handle event
        switch (event.get_gesture_phase()) {
        
            case Clutter.TouchpadGesturePhase.BEGIN:
                return this._gestureStarted();
                
            case Clutter.TouchpadGesturePhase.UPDATE:
                let [dx, dy] = event.get_gesture_motion_delta();
                return this._gestureUpdate(dx, dy);
                
            default: //CANCEL or END
                return this._gestureEnd();
        }
        
        return Clutter.EVENT_STOP;

    }
    
    _gestureStarted() {
    
        let [pointerX, pointerY, pointerZ] = global.get_pointer();
        const windowClutterActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, pointerX, pointerY).get_parent();
  
        // Do not reply on gestures, if pointer is not on top of a window
        if (windowClutterActor.get_meta_window == undefined)
        	return Clutter.EVENT_PROPAGATE;
        	
	this._movingMetaWindow = windowClutterActor.get_meta_window();
	
	// Don't do anything, if window move is not allowed
	if (!this._movingMetaWindow.allows_move())
		return Clutter.EVENT_PROPAGATE;	
		
	// Calculate workspace data
	this._monitorGeometry = this._movingMetaWindow.get_work_area_current_monitor();
	this._posRect.x = pointerX;
	this._posRect.y = pointerY;
	this._monitorIndex = global.display.get_monitor_index_for_rect(this._posRect);
		
	// End gesture if window is closed
	const outerThis = this;
	this._unmanagedHandler = this._movingMetaWindow.connect('unmanaged', function() {
		outerThis._movingMetaWindow.disconnect(outerThis._unmanagedHandler);
		outerThis._movingMetaWindow.disconnect(outerThis._sizeHandler);
		outerThis._unmanagedHandler = null;
		outerThis._sizeHandler = null;
		
		outerThis._movingMetaWindow = null;
		outerThis._nextSnapAction = SnapAction.NONE;
	});
	
	// Connect to workspace-changed
	this._workspaceChangedHandler = this._movingMetaWindow.connect('workspace-changed', function() {
		outerThis._monitorGeometry = outerThis._movingMetaWindow.get_work_area_current_monitor();
		[pointerX, pointerY, pointerZ] >= global.get_pointer();
		outerThis._posRect.x = pointerX;
		outerThis._posRect.y = pointerY;
		outerThis._monitorIndex = global.display.get_monitor_index_for_rect(outerThis._posRect);
	});
	
	// Handle maximized window
	if (this._movingMetaWindow.get_maximized() != 0) {
	
	        // Activate window
		const currentTime = global.get_current_time();
		if (!this._movingMetaWindow.has_focus())
			this._movingMetaWindow.activate(currentTime);
	
		// Unmaximize		
	    	this._movingMetaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
		
		// Connect to _sizeChanged
		this._sizeHandler = this._movingMetaWindow.connect('size-changed', function(){
			outerThis._movingMetaWindow.disconnect(outerThis._sizeHandler);
		    	outerThis._sizeHandler = null;
		    	const windowSize = outerThis._movingMetaWindow.get_frame_rect();
		    	
		    	// Update window-center
		    	outerThis._pointerWindowDiffX = -windowSize.width / 2;
			outerThis._pointerWindowDiffY = -windowSize.height / 2;	
		});
		
		
	    	const frameRect = this._movingMetaWindow.get_frame_rect();	
		
		// Can center window to pointer, because window->saved_rect is private in mutter
		this._pointerWindowDiffX = -frameRect.width / 3;
		this._pointerWindowDiffY = -frameRect.height / 3;
	} else {
		// Store delta from pointer to window pos
		const frameRect = this._movingMetaWindow.get_frame_rect();
		this._pointerWindowDiffX = frameRect.x - pointerX;
		this._pointerWindowDiffY = frameRect.y - pointerY;
	}
	
	return Clutter.EVENT_STOP;     
    }
    
    _gestureUpdate(dx, dy) {
	
	// Pointer not on top of a window
	if (this._movingMetaWindow == null)
            return Clutter.EVENT_PROPAGATE;
        
        // Focus window
        const currentTime = global.get_current_time();
        if (!this._movingMetaWindow.has_focus())
		this._movingMetaWindow.activate(currentTime);
        
        // Move
        const [pointerX, pointerY, pointerZ] = global.get_pointer();
        this._virtualTouchpad.notify_relative_motion(currentTime, dx, dy);  
        this._movingMetaWindow.move_frame(true, 
        	pointerX + this._pointerWindowDiffX, 
        	pointerY + this._pointerWindowDiffY);
        	
	// Handle window snap
	if (!this._movingMetaWindow.can_maximize())
		return Clutter.EVENT_STOP;
	if (pointerX < this._monitorGeometry.x + EDGE_THRESHOLD) {
		// Handle snap to left
		if (this._nextSnapAction != SnapAction.TILE_LEFT) {
			this._nextSnapAction = SnapAction.TILE_LEFT;
			this._previewRect.x = this._monitorGeometry.x;
			this._previewRect.y = this._monitorGeometry.y;
			this._previewRect.height = this._monitorGeometry.height;
			
			// Handle preview width
			const width = this._windowAtPos(this._monitorGeometry.x + this._monitorGeometry.width - 1, true);
			if (width)
				this._previewRect.width = width;
			else 
				this._previewRect.width = this._monitorGeometry.width / 2;
			global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._previewRect, this._monitorIndex);
		}
	} else if (pointerX > this._monitorGeometry.x + this._monitorGeometry.width - EDGE_THRESHOLD) {
		// Handle snap to right
		if (this._nextSnapAction != SnapAction.TILE_RIGHT) {
			this._nextSnapAction = SnapAction.TILE_RIGHT;
			this._previewRect.y = this._monitorGeometry.y;
			this._previewRect.height = this._monitorGeometry.height;
			
			// Handle preview width
			const width = this._windowAtPos(this._monitorGeometry.x, false);
			if (width)
				this._previewRect.width = width;
			else
				this._previewRect.width = this._monitorGeometry.width / 2;
				
			this._previewRect.x = this._monitorGeometry.x + this._monitorGeometry.width - this._previewRect.width;
			global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._previewRect, this._monitorIndex);
		}
	} else if (pointerY < this._monitorGeometry.y + 1) {
		// Handle maximize
		if (this._nextSnapAction != SnapAction.MAXIMIZE) {
			this._nextSnapAction = SnapAction.MAXIMIZE;
			global.window_manager.emit("show-tile-preview", this._movingMetaWindow, this._monitorGeometry, this._monitorIndex);
		}
	} else if (this._nextSnapAction != SnapAction.NONE) {
		// Hide tile-preview, if there won't be a snap
		this._nextSnapAction = SnapAction.NONE;
		global.window_manager.emit("hide-tile-preview");
	}
	
	return Clutter.EVENT_STOP;

    }
    
    _gestureEnd() {
    
    	// Nothing to move around
    	if (this._movingMetaWindow == null)
    		return Clutter.EVENT_PROPAGATE;
    	
    	// Hide tile-preview
    	if (this._nextSnapAction != SnapAction.NONE)
    		global.window_manager.emit("hide-tile-preview");
    	
    	// Do snap
    	const currentTime = global.get_current_time();
    	switch (this._nextSnapAction) {
    		case SnapAction.MAXIMIZE:
    			this._movingMetaWindow.maximize(Meta.MaximizeFlags.BOTH);
    			break;
		case SnapAction.TILE_LEFT:
		 	this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Left, Clutter.KeyState.PRESSED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Left, Clutter.KeyState.RELEASED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
			break;
		case SnapAction.TILE_RIGHT:
		 	this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Right, Clutter.KeyState.PRESSED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Right, Clutter.KeyState.RELEASED);
			this._virtualKeyboard.notify_keyval(currentTime, Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);		
			break;
    	}
    	
    	// Reset
    	if (this._sizeHandler != null)
    		this._movingMetaWindow.disconnect(this._sizeHandler);
    		
	if (this._unmanagedHandler != null)
		this._movingMetaWindow.disconnect(this._unmanagedHandler);
		
	if (this._workspaceChangedHandler != null)
		this._movingMetaWindow.disconnect(this._workspaceChangedHandler);
    		
	this._sizeHandler = null;
	this._unmanagedHandler = null;
        this._movingMetaWindow = null;
        this._nextSnapAction = SnapAction.NONE;
        
        return Clutter.EVENT_STOP;
    }
    
    // Really not the nicest way but it seems as if there is no API avaliable to test if window ist tiled
    _windowAtPos(xLook, left) {
    	const metaActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, xLook, this._monitorGeometry.y).get_parent();
    	// There is no other window
	if (metaActor == null || metaActor.get_meta_window == undefined)
		return false;
	const metaWindow = metaActor.get_meta_window();
	const metaWindowRect = metaWindow.get_frame_rect();
	// Other window is not at topmost position
	if (metaWindowRect.y != this._monitorGeometry.y)
		return false;
		
	if (left) {
		// Other window is not at rightmost position
		if (metaWindowRect.x + metaWindowRect.width != this._monitorGeometry.x + this._monitorGeometry.width)
			return false;
	} else {
		// Other window is not at leftmost position
		if (metaWindowRect.x != this._monitorGeometry.x)
			return false;
	}	
			
	// Only if window ist vertically maximized return width
	if (metaWindowRect.height === this._monitorGeometry.height && metaWindow.get_maximized() === Meta.MaximizeFlags.VERTICAL)
		return this._monitorGeometry.width - metaWindowRect.width;
	
	return false;
    }
        
    _cleanup() {
        global.stage.disconnect(this._gestureCallbackID);
    }

};

function enable() {
    Signals.addSignalMethods(TouchpadGestureAction.prototype);
    gestureHandler = new TouchpadGestureAction(global.stage);
}

function disable(){
    gestureHandler._cleanup();
}
