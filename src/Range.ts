export class Range {
    private startSelector;
    private endSelector;
    private range;
    private type;
    private id;

    public constructor({ type, id }) {
        this.startSelector = "[" + ["data", type, "start"].join("-") + "=\"" + id + "\"]";
        this.endSelector = "[" + ["data", type, "end"].join("-") + "=\"" + id + "\"]";
        this.type = type;
        this.id = id;
    }

    public getElementsByClassName(classNames: string): Element[] {
        return this.depthFirstSearch(classNames.split(" ").map(function(name) {
            return "." + name;
        }).join(" "));
    }

    public getElementByName(elementName: string): Element | null {
        return this.depthFirstSearch("[name=\"" + [this.type, this.id, elementName].join("-") + "\"]", { "returnFirstResult": true })[0] ?? null;
    }

    public getElementsByName(elementName: string): Element[] | null {
        return this.depthFirstSearch("[name$=\"" + elementName + "\"]");
    }

    public getElementsByTagName(qualifiedName: string): Element[] | null {
        return this.depthFirstSearch(qualifiedName);
    }

    public querySelector(selectors: string): Element | null {
        return this.depthFirstSearch(selectors, { "returnFirstResult": true })[0] ?? null;
    }

    public $(selectors): Element | null {
        return this.querySelector(selectors);
    }

    public querySelectorAll(selectors): Element[] | null {
        return this.depthFirstSearch(selectors);
    }

    public $$(selectors): Element[] | null {
        return this.querySelectorAll(selectors);
    }

    private depthFirstSearch(selector, options = {}): Element[] {
        options["returnFirstResult"] ??= false;

        if (this.range === undefined) {
            this.range = document.createRange();
            this.range.setStart(document.querySelector(this.startSelector), 0);
            this.range.setEnd(document.querySelector(this.endSelector), 0);
        }

        const results = [];

        for (let element = this.range.startContainer; element !== null && this.range.comparePoint(element, 0) === 0; element = element.nextElementSibling) {
            if (options["returnFirstResult"] === true && results.length === 1) {
                break;
            }

            (function recurse(node) {
                if (node.matches(selector)) {
                    results.push(node);
                }

                if (options["returnFirstResult"] === true && results.length === 1) {
                    return;
                }

                for (const child of node.children) {
                    recurse(child);
                }
            })(element);
        }

        return results;
    }
}
