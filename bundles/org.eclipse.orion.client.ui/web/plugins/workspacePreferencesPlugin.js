/*******************************************************************************
 * @license
 * Copyright (c) 2012 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 * 
 * Contributors: IBM Corporation - initial API and implementation
 ******************************************************************************/
/*eslint-env browser, amd*/
define(["orion/xhr", "orion/plugin", "domReady!"], function(xhr, PluginProvider) {
	function PreferencesProvider(location) {
		this.location = location;
	}

	PreferencesProvider.prototype = {
		get: function(id, name) {
			return xhr("GET", this.location + "/" + id + name, {
				headers: {
					"Orion-Version": "1"
				},
				timeout: 15000,
				log: false
			}).then(function(result) {
				return result.response ? JSON.parse(result.response) : null;
			});
		},
		put: function(id, name, data) {
			return xhr("PUT", this.location + "/" + id + name, {
				data: JSON.stringify(data),
				headers: {
					"Content-Type": "application/json;charset=UTF-8",
					"Orion-Version": "1"
				},
				timeout: 15000
			}).then(function(result) {
				return result.response ? JSON.parse(result.response) : null;
			});
		},
		remove: function(id, name, key){
			return xhr("DELETE", this.location + "/" + id + name +"?key=" + encodeURIComponent(key), {
				headers: {
					"Orion-Version": "1"
				},
				timeout: 15000
			}).then(function(result) {
				return result.response ? JSON.parse(result.response) : null;
			});
		}
	};

	function connect() {
		var login = new URL("../mixloginstatic/LoginWindow.html", self.location.href).href;
		var headers = {
			name: "Orion Preferences",
			version: "1.0",
			description: "This plugin provides access to workspace preferences.",
			login: login
		};
		var pluginProvider = new PluginProvider(headers);
		registerServiceProviders(pluginProvider);
		pluginProvider.connect();
	}

	function registerServiceProviders(provider) {
		var service = new PreferencesProvider(new URL("../prefs/workspace", self.location.href).href);
		provider.registerService("orion.core.workspacePreference.provider", service, {});
	}

	return {
		connect: connect,
		registerServiceProviders: registerServiceProviders
	};
});