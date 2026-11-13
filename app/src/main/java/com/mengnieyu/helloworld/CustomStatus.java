package com.mengnieyu.helloworld;

import org.nanohttpd.protocols.http.response.IStatus;

public class CustomStatus implements IStatus {
    protected int code;
    protected String description;

    public CustomStatus(int code, String text) {
        this.code = code;
        // the status line is "HTTP/1.1 " + description, so it has to be "200 OK" (it used to be left null,
        // which sent "HTTP/1.1 null": the WebView put up with that, other browsers do not have to)
        this.description = code + " " + text;
    }
    @Override
    public int getRequestStatus() {
        return this.code;
    }

    @Override
    public String getDescription() {
        return this.description;
    }
}
