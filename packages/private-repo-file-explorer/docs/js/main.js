document.addEventListener("DOMContentLoaded", async function(event) {

	let repository = "<%= repository %>";

	const isLocal = location.hostname === "localhost";

	const tree = [];

	window.addEventListener("hashchange", async function(event) {
		if (location.hash.endsWith("..")) {
			location.hash = location.hash.replace(/[^\/]*\/..$/, "");

			return;
		}

		let breadcrumbs = [`
			<span class="js-path-segment d-inline-block wb-break-all">
				<a data-pjax="#repo-content-pjax-container" href="#/">
					<span>${repository}</span>
				</a>
			</span>
		`];

		let partialPath = "";

		let lastBreadcrumb = repository;

		for (const directory of location.hash.substring(1).match(/([^/]+)/g) || []) {
			partialPath += "/" + directory;

			breadcrumbs.push(`
				<span class="js-path-segment d-inline-block wb-break-all">
					<a data-pjax="#repo-content-pjax-container" href="#${partialPath}/">
						<span>${directory}</span>
					</a>
				</span>
			`);

			lastBreadcrumb = directory;
		}

		document.title = lastBreadcrumb;

		breadcrumbs = [breadcrumbs.join("<span class=\"mx-1\">/</span>")];

		if (location.hash.endsWith("/")) {
			breadcrumbs.push("<span class=\"mx-1\">/</span>");
		}

		document.getElementById("breadcrumb").innerHTML = breadcrumbs.join("\n");

		if (!location.hash.endsWith("/")) {
			document.getElementById("files").innerHTML = `
				<div role="row" class="Box-header Box-row--focus-gray p-0 pr-2 d-flex flex-shrink-0 flex-md-row flex-items-center js-navigation-item">
					<div role="rowheader" class="flex-auto min-width-0 col-md-2">
						<a rel="nofollow" title="Go to parent directory" class="js-navigation-open d-block py-2 px-3" href="${location.hash}/..">
							<span class="text-bold text-center d-inline-block" style="min-width: 16px;">. .</span>
						</a>
					</div>
					<div class="d-flex py-1 py-md-0 flex-auto flex-order-1 flex-md-order-2 flex-sm-grow-0 flex-justify-between">
						<div class="BtnGroup">
							<a href="${location.hash.substring(2)}" id="raw-url" role="button" data-view-component="true" class="btn-sm btn BtnGroup-item"> Raw </a>
						</div>
					</div>
				</div>
				<div id="code" itemprop="text" class="Box-body p-0 blob-wrapper data type-html gist-border-0"></div>
			`;

			const buffer = [];

			const lines = hljs.highlightAuto(await (await fetch(location.hash.substring(2))).text()).value.split("\n");

			for (let x = 0; x < lines.length; x++) {
				buffer.push(`
					<tr>
						<td id="L${x + 1}" class="blob-num js-line-number" data-line-number="${x + 1}"></td>
						<td id="LC${x + 1}" class="blob-code blob-code-inner js-file-line">${lines[x]}</td>
					</tr>
				`);
			}

			document.getElementById("code").innerHTML = `
				<table>
					<tbody>
						${buffer.join("\n")}
					</tbody>
				</table>
			`;

			return;
		}

		const files = [];
		const folders = [];

		if (isLocal) {
			const response = await (await fetch(location.href.replace("#", "~"))).json()

			files.push(...response["files"]);
			folders.push(...response["folders"]);
		} else {
			for (const file of tree) {
				const basePath = location.hash.replace("#", ".");

				if (file.startsWith(basePath)) {
					let fileName = file.substring(basePath.length);

					if (!fileName.includes("/")) {
						files.push(fileName);
					} else {
						fileName = fileName.substring(0, fileName.indexOf("/"));

						if (!folders.includes(fileName)) {
							folders.push(fileName);
						}
					}
				}
			}
		}

		const buffer = [];

		if (location.hash !== "#/") {
			buffer.push(`
				<div role="row" class="Box-row Box-row--focus-gray p-0 d-flex js-navigation-item">
					<div role="rowheader" class="flex-auto min-width-0 col-md-2">
						<a rel="nofollow" title="Go to parent directory" class="js-navigation-open d-block py-2 px-3" href="${location.hash}..">
							<span class="text-bold text-center d-inline-block" style="min-width: 16px;">. .</span>
						</a>
					</div>
				</div>
			`);
		}

		for (const folder of folders) {
			buffer.push(`
				<div role="row" class="Box-row Box-row--focus-gray py-2 d-flex position-relative js-navigation-item">
					<div role="gridcell" class="mr-3 flex-shrink-0" style="width: 16px;">
						<svg aria-label="Directory" aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-file-directory hx_color-icon-directory">
							<path fill-rule="evenodd" d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3h-6.5a.25.25 0 01-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7h-3.5z"></path>
						</svg>
					</div>
					<div role="rowheader" class="flex-auto min-width-0 col-md-2 mr-3">
						<span class="css-truncate css-truncate-target d-block width-fit"><a class="js-navigation-open Link--primary" title="${folder}" href="${location.hash + folder}/">${folder}</a></span>
					</div>
					<div role="gridcell" class="d-none d-md-block"></div>
					<div role="gridcell"></div>
				</div>
			`);
		}

		for (const file of files) {
			buffer.push(`
				<div role="row" class="Box-row Box-row--focus-gray py-2 d-flex position-relative js-navigation-item">
					<div role="gridcell" class="mr-3 flex-shrink-0" style="width: 16px;">
						<svg aria-label="File" aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" data-view-component="true" class="octicon octicon-file color-icon-tertiary">
							<path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"></path>
						</svg>
					</div>
					<div role="rowheader" class="flex-auto min-width-0 col-md-2 mr-3">
						<span class="css-truncate css-truncate-target d-block width-fit"><a class="js-navigation-open Link--primary" title="${file}" href="${location.hash + file}">${file}</a></span>
					</div>
					<div role="gridcell" class="d-none d-md-block"></div>
					<div role="gridcell"></div>
				</div>
			`);
		}

		document.getElementById("files").innerHTML = buffer.join("\n");
	});

	if (location.hostname.endsWith("github.io")) {
		tree.push(...(await (await fetch(location.pathname + "/tree.txt")).text()).split("\n"));

		const matches = location.href.replace(/\./g, "/").split("/");

		const username = matches[2];
		repository = matches[5];

		const links = document.body.querySelectorAll("[href]");

		for (const link of links) {
			for (let [placeholder, value] of Object.entries({ "username": username, "repository": repository })) {
				const placeholders = [
					"<%= " + placeholder + " %>",
					"%3C%=%20" + placeholder + "%20%%3E",
					"%3C%25%3D%20" + placeholder + "%20%25%3E"
				];

				const placeholderRegex = new RegExp("(?:" + placeholders.join(")|(?:") + ")", "g");

				for (const attribute of ["href", "textContent", "title"]) {
					if (placeholderRegex.test(link[attribute])) {
						link[attribute] = link[attribute].replace(placeholderRegex, value);
					}
				}
			}
		}

		document.getElementById("description").remove();
		document.querySelector("#responsive-meta-container p").remove();
	}

	if (!location.hash.startsWith("#/")) {
		location.replace(location.pathname + "#/");
	} else {
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	}

});
